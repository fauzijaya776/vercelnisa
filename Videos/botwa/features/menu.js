let handler = async (m, { usedPrefix }) => {
  let menunya = `*╭────〔 ADMIN 〕─*\n*┊・* ${usedPrefix}send\n*┊・* ${usedPrefix}liststok\n*┊・* ${usedPrefix}addstok\n*┊・* ${usedPrefix}delakun\n*┊・* ${usedPrefix}delstok\n*┊・* ${usedPrefix}setdesk\n*┊・* ${usedPrefix}setharga\n*┊・* ${usedPrefix}setjudul\n*┊・* ${usedPrefix}setpaydisini\n*┊・* ${usedPrefix}setstok\n*┊・* ${usedPrefix}addbulk\n*┊・* ${usedPrefix}hapusbulk\n*┊・* ${usedPrefix}exportstok\n*╰┈┈┈┈┈┈┈┈*\n*╭────〔 MAIN 〕─*\n*┊・* ${usedPrefix}msg\n*┊・* ${usedPrefix}claimgaransi\n*┊・* ${usedPrefix}hidetag\n*┊・* ${usedPrefix}buy\n*┊・* ${usedPrefix}menu\n*┊・* ${usedPrefix}riwayat\n*┊・* ${usedPrefix}stok\n*╰┈┈┈┈┈┈┈┈*`
  await m.reply(menunya);
};

handler.help = ['menu', 'help'];
handler.tags = ['main'];
handler.command = ['menu', 'help'];
handler.register = true;

module.exports = handler;
