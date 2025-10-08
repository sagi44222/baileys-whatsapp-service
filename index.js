const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode-terminal');
const P = require('pino');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

const rateLimit = require('express-rate-limit');

// Create rate limiter: 100 requests per 15 minutes per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per window per IP
  message: {
    error: 'Too many requests from this IP',
    message: 'Please try again in 15 minutes'
  },
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  // Skip limiting for health checks
  skip: (req) => req.path === '/health'
});

// Apply rate limiter to all /api routes
app.use('/api/', apiLimiter);
// ===== END NEW SECTION =====

// Logger
const logger = P({ level: 'info' });

// WhatsApp Socket
let sock = null;
let qrCodeData = null;
let isConnected = false;

const API_SECRET_KEY = process.env.API_SECRET_KEY;
const authenticateRequest = (req, res, next) => {
  // Get API key from header
  const apiKey = req.headers['x-api-key'] ||
                 req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    logger.warn(`🚫 Missing API key from ${req.ip} to ${req.path}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key is required. Provide via X-API-Key header.'
    });
  }

  if (apiKey !== API_SECRET_KEY) {
    logger.warn(`🚫 Invalid API key from ${req.ip} to ${req.path}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }

  // API key is valid, continue
  next();
};
// Rate limiting
class RateLimiter {
  constructor() {
    this.messageQueue = [];
    this.isProcessing = false;
    this.MIN_DELAY = 3000; // 3 seconds
    this.MAX_DELAY = 8000; // 8 seconds
    this.dailyCount = 0;
    this.MAX_PER_DAY = 100;
    this.lastResetDate = new Date().toDateString();
  }

  resetIfNewDay() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyCount = 0;
      this.lastResetDate = today;
    }
  }

  async addToQueue(jid, content) {
    this.resetIfNewDay();

    if (this.dailyCount >= this.MAX_PER_DAY) {
      throw new Error('Daily message limit reached');
    }

    return new Promise((resolve, reject) => {
      this.messageQueue.push({ jid, content, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing || this.messageQueue.length === 0) return;

    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const { jid, content, resolve, reject } = this.messageQueue.shift();

      try {
        // Random delay to avoid spam detection
        const delay = this.MIN_DELAY + Math.random() * (this.MAX_DELAY - this.MIN_DELAY);
        await new Promise(r => setTimeout(r, delay));

        // Send message
        await sock.sendMessage(jid, content);
        this.dailyCount++;

        logger.info(`Message sent to ${jid}. Daily count: ${this.dailyCount}`);
        resolve({ success: true });
      } catch (error) {
        logger.error(`Failed to send message: ${error.message}`);
        reject(error);
      }
    }

    this.isProcessing = false;
  }
}

const rateLimiter = new RateLimiter();

// Connect to WhatsApp
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger,
    browser: ['הסעות קיבוץ', 'Chrome', '10.0']
  });

  // Save credentials when updated
  sock.ev.on('creds.update', saveCreds);

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Store QR code
    if (qr) {
      qrCodeData = qr;
      QRCode.generate(qr, { small: true });
      logger.info('QR Code generated - scan with WhatsApp');
    }

    // Connection status
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      isConnected = false;
      logger.info('Connection closed. Reconnecting:', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 5000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      qrCodeData = null;
      logger.info('✅ WhatsApp connected successfully!');
    }
  });

  // Handle incoming messages (optional - for testing)
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    logger.info(`Received message: ${text}`);
  });
}

// Message templates
function generateNewRideMessage(ride) {
  const greetings = ['🚗 הסעה חדשה בקיבוץ!', '🚙 בקשת הסעה חדשה', '🚐 מישהו צריך הסעה'];
  const greeting = greetings[Math.floor(Math.random() * greetings.length)];

  const nightIndicator = ride.tariff_applied === 'night' ? ' 🌙' : '';

  return `${greeting}

📍 מ: ${ride.pickup_location}
📍 ל: ${ride.destination_location}
🕐 ${ride.ride_date} ${ride.ride_time}
👥 ${ride.num_passengers} נוסעים
💰 ₪${ride.estimated_cost}${nightIndicator} | 📏 ${ride.distance_km} ק"מ

נוסע: ${ride.requester_name}

👉 לקבלת ההסעה (ראשון מקבל):
${process.env.WEB_APP_URL || 'kibuttz-ride.web.app'}/accept/${ride.request_id}

${ride.repost_count > 0 ? '🔄 הסעה מחודשת - הנהג הקודם ביטל\n' : ''}הודעה אוטומטית | ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
}

function generateRideTakenMessage(ride, driverName) {
  return `✅ ההסעה נלקחה

נהג: ${driverName}
${ride.pickup_location} → ${ride.destination_location}
${ride.ride_date} ${ride.ride_time}

הודעה אוטומטית`;
}

function generatePassengerConfirmation(ride, driver) {
  const nightNote = ride.tariff_applied === 'night'
    ? '\n\n⚠️ שים לב: תעריף לילה (22:00-06:00) חל על הסעה זו.'
    : '';

  return `היי ${ride.requester_name}! 🎉

ההסעה שלך אושרה!

🚗 נהג: ${driver.full_name}
📞 טלפון: ${driver.phone_number}

📍 מ: ${ride.pickup_location}
📍 ל: ${ride.destination_location}
🕐 ${ride.ride_date} בשעה ${ride.ride_time}
👥 ${ride.num_passengers} נוסעים
💰 עלות: ₪${ride.estimated_cost}${nightNote}

לפרטים מלאים: ${process.env.WEB_APP_URL || 'kibuttz-ride.web.app'}/rides/${ride.request_id}

הסעות קיבוץ
לביטול הודעות: ${process.env.WEB_APP_URL || 'kibuttz-ride.web.app'}/settings`;
}

function generateDriverConfirmation(ride) {
  return `היי ${ride.driver_name}! ✅

קיבלת הסעה חדשה:

👤 נוסע: ${ride.requester_name}
📞 טלפון: ${ride.requester_phone}

📍 מ: ${ride.pickup_location}
📍 ל: ${ride.destination_location}
🕐 ${ride.ride_date} בשעה ${ride.ride_time}
👥 ${ride.num_passengers} נוסעים
💰 תשלום: ₪${ride.estimated_cost}

לפרטים: ${process.env.WEB_APP_URL || 'kibuttz-ride.web.app'}/rides/${ride.request_id}

הסעות קיבוץ`;
}

function generateReminderMessage(ride, isDriver) {
  const recipient = isDriver ? ride.driver_name : ride.requester_name;
  const otherPerson = isDriver ? ride.requester_name : ride.driver_name;
  const otherPhone = isDriver ? ride.requester_phone : ride.driver_phone;

  return `⏰ תזכורת: הסעה בעוד שעה!

היי ${recipient},

${isDriver ? 'נוסע' : 'נהג'}: ${otherPerson}
📞 ${otherPhone}

📍 מ: ${ride.pickup_location}
📍 ל: ${ride.destination_location}
🕐 ${ride.ride_time}

הסעות קיבוץ`;
}

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: isConnected,
    hasQR: !!qrCodeData,
    dailyMessageCount: rateLimiter.dailyCount
  });
});

// Get QR code (for initial setup)
app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData });
  } else if (isConnected) {
    res.json({ message: 'Already connected' });
  } else {
    res.json({ message: 'Connecting... Please wait' });
  }
});

// Get all WhatsApp groups
app.get('/api/get-groups', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const groups = await sock.groupFetchAllParticipating();

    const groupList = Object.values(groups).map(group => ({
      name: group.subject,
      jid: group.id,
      participants: group.participants.length,
      created: new Date(group.creation * 1000).toISOString()
    }));

    res.json({
      success: true,
      count: groupList.length,
      groups: groupList
    });

  } catch (error) {
    logger.error('Error fetching groups:', error);
    res.status(500).json({ error: error.message });
  }
});
// Send new ride to drivers group
app.post('/api/notify-drivers-new-ride',authenticateRequest, async (req, res) => {
  try {
    if (!isConnected) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const { ride, groupJid } = req.body;

    if (!ride || !groupJid) {
      return res.status(400).json({ error: 'Missing ride or groupJid' });
    }

    const message = generateNewRideMessage(ride);

    await rateLimiter.addToQueue(groupJid, { text: message });

    logger.info(`New ride posted to group: ${ride.request_id}`);
    res.json({ success: true, messageCount: rateLimiter.dailyCount });

  } catch (error) {
    logger.error('Error posting new ride:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send ride taken update to group
app.post('/api/notify-drivers-ride-taken',authenticateRequest, async (req, res) => {
  try {
    if (!isConnected) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const { ride, driverName, groupJid } = req.body;

    if (!ride || !driverName || !groupJid) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const message = generateRideTakenMessage(ride, driverName);

    await rateLimiter.addToQueue(groupJid, { text: message });

    logger.info(`Ride taken update posted: ${ride.request_id}`);
    res.json({ success: true });

  } catch (error) {
    logger.error('Error posting ride taken:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send individual message (confirmations, reminders, etc)
app.post('/api/send-individual',authenticateRequest, async (req, res) => {
  try {
    if (!isConnected) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'Missing phone or message' });
    }

    // Format phone number for WhatsApp (remove + and add @s.whatsapp.net)
    const jid = phone.replace('+', '') + '@s.whatsapp.net';

    await rateLimiter.addToQueue(jid, { text: message });

    logger.info(`Individual message sent to ${phone}`);
    res.json({ success: true });

  } catch (error) {
    logger.error('Error sending individual message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send reminder
app.post('/api/send-reminder',authenticateRequest, async (req, res) => {
  try {
    if (!isConnected) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const { ride, recipientPhone, isDriver } = req.body;

    if (!ride || !recipientPhone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const message = generateReminderMessage(ride, isDriver);
    const jid = recipientPhone.replace('+', '') + '@s.whatsapp.net';

    await rateLimiter.addToQueue(jid, { text: message });

    logger.info(`Reminder sent to ${recipientPhone}`);
    res.json({ success: true });

  } catch (error) {
    logger.error('Error sending reminder:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get connection status
app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    dailyMessages: rateLimiter.dailyCount,
    queueLength: rateLimiter.messageQueue.length
  });
});

// Start server
app.listen(PORT, async () => {
  logger.info(`🚀 Baileys service running on port ${PORT}`);

  // Check if API key is configured
  if (!API_SECRET_KEY) {
    logger.error('❌❌❌ WARNING: API_SECRET_KEY not set! Service is UNPROTECTED! ❌❌❌');
    logger.error('Set API_SECRET_KEY environment variable immediately!');
  } else {
    logger.info('🔒 API authentication enabled');
  }

  logger.info('Connecting to WhatsApp...');
  await connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  if (sock) {
    await sock.logout();
  }
  process.exit(0);
});