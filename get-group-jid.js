@"
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

async function getGroups() {
  console.log('🔍 Fetching WhatsApp groups...\n');

  const { state } = await useMultiFileAuthState('./auth_info_baileys');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  await new Promise((resolve, reject) => {
    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        console.log('✅ Connected to WhatsApp\n');
        resolve();
      }
      if (update.connection === 'close') {
        reject(new Error('Connection closed'));
      }
    });
  });

  const groups = await sock.groupFetchAllParticipating();

  console.log('Found ' + Object.keys(groups).length + ' groups:\n');
  console.log('='.repeat(60));

  Object.values(groups).forEach((group, index) => {
    console.log('\n' + (index + 1) + '. Group Name: ' + group.subject);
    console.log('   Group JID: ' + group.id);
    console.log('   Participants: ' + group.participants.length);
    console.log('   Created: ' + new Date(group.creation * 1000).toLocaleDateString('he-IL'));
  });

  console.log('\n' + '='.repeat(60));
  console.log('\n📋 Copy the JID of your drivers group (format: 120363XXXXXXXXXX@g.us)');
  console.log('   You will need this for Firebase configuration!\n');

  process.exit(0);
}

getGroups().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
"@ | Out-File -FilePath "get-group-jid.js" -Encoding utf8