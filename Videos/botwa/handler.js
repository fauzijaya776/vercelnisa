const simple = require('./function/simple')
const util = require('util')
const {
  color
} = require('./function/color')
const moment = require("moment-timezone")
const fs = require('fs')
const fetch = require("node-fetch")
const axios = require('axios');
const generateQRCode = require('./function/qrgen');
const qs = require('qs');

/* ~~~~~~~~~ PAYMENT GATEWAY ~~~~~~~~~ */
const {
  createNewOrder,
  checkTransactionStatus,
  checkProfileInformation,
  cancelTransaction,
} = require('./function/payment_gateway');

/* ~~~~~~~~~ DATA STOCK ~~~~~~~~~ */
const {
  delStock,
  setStock,
  getProductList,
  changeTitle,
  changePrice,
  changeDescription,
  addHistory,
} = require('./function/store')

// New stock management functions
const addStock = (stockInput, dbStockList) => {
  const parts = stockInput.split('|');
  if (parts.length < 6) throw new Error('Invalid format');
  const [code,
    name,
    priceStr,
    description,
    user,
    pass,
    ...notes] = parts;
  const price = parseInt(priceStr);
  if (isNaN(price) || price <= 0) throw new Error('Invalid price');

  let stock = dbStockList.find(s => s.code === code.toLowerCase());
  if (!stock) {
    stock = {
      code: code.toLowerCase(),
      name,
      price,
      description,
      stockSold: 0,
      totalStock: 0,
      accounts: []
    };
    dbStockList.push(stock);
  }

  const account = {
    user,
    pass,
    date: new Date().toISOString(),
    notes: notes.filter(note => note.trim())
  };
  stock.accounts.push(account);
  stock.totalStock += 1;

  saveDB(dbStockList);
  return stock;
};

const delAccountFromStock = (productCode, accountIndex, dbStockList) => {
  const stock = dbStockList.find(s => s.code === productCode.toLowerCase());
  if (!stock || accountIndex < 1 || accountIndex > stock.accounts.length) return null;
  const deleted = stock.accounts.splice(accountIndex - 1, 1)[0];
  stock.totalStock = stock.accounts.length;
  saveDB(dbStockList);
  return deleted;
};

// Load stock data with cleanup on startup
let db_stock_list = JSON.parse(fs.readFileSync('./db_stock.json')).map(stock => ({
  ...stock,
  stockSold: stock.stockSold || 0,
  totalStock: stock.totalStock || stock.accounts.length,
  accounts: stock.accounts.map(acc => ({
    user: acc.email || acc.user,
    pass: acc.password || acc.pass,
    date: acc.date || new Date().toISOString(),
    reservedUntil: acc.reservedUntil,
    notes: acc.notes || []
  }))
}));

// Save database function
function saveDB(db) {
  fs.writeFileSync('./db_stock.json', JSON.stringify(db, null, 3));
}

// Fungsi untuk membersihkan reservasi yang kadaluarsa
function cleanExpiredReservations() {
  let cleaned = false;
  db_stock_list.forEach(stock => {
    stock.accounts = stock.accounts.map(acc => {
      if (acc.reservedUntil && new Date(acc.reservedUntil) < new Date()) {
        delete acc.reservedUntil;
        cleaned = true;
      }
      return acc;
    });
  });
  if (cleaned) {
    saveDB(db_stock_list);
    console.log('Membersihkan reservasi yang kadaluarsa saat startup');
  }
}

// Jalankan pembersihan saat startup
cleanExpiredReservations();

/* ~~~~~~~~~ SETTINGS ~~~~~~~~~ */
const {
  globalSettings,
  saveSettings
} = require('./settings');
try {
  const savedSettings = require('./global_settings.json');
  Object.assign(globalSettings, savedSettings);
} catch (error) {
  console.log("Failed to load settings:", error);
}

const isNumber = x => typeof x === 'number' && !isNaN(x)
const delay = ms => isNumber(ms) && new Promise(resolve => setTimeout(resolve, ms))
const sleep = async (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkPendingTransactionsOnStartup() {
  console.log('[SISTEM] Memulai pembersihan transaksi tertunda...');

  for (const [jid, user] of Object.entries(global.db.data.users)) {
    if (user.buynow === 'Pending' && user.kode_unik) {
      try {
        console.log(`[SISTEM] Memproses transaksi ${user.kode_unik} untuk ${jid}`);

        // 1. Hitung waktu transaksi
        const waktuTransaksi = new Date(user.regTime);
        const waktuSekarang = new Date();
        const menitBerjalan = (waktuSekarang - waktuTransaksi) / (1000 * 60);

        // 2. Jika lebih dari 5 menit, batalkan
        if (menitBerjalan > 5) {
          console.log(`[KADALUARSA] Transaksi ${user.kode_unik} sudah ${menitBerjalan} menit`);

          // 3. Bebaskan akun yang terkunci
          const kodeProduk = user.lockedAccounts?.[0]?.productCode;
          if (kodeProduk) {
            const stok = db_stock_list.find(s => s.code === kodeProduk);
            if (stok) {
              stok.accounts.forEach(akun => {
                if (akun.reservedUntil) {
                  delete akun.reservedUntil;
                }
              });
              saveDB(db_stock_list);
            }
          }

          // 4. Update status transaksi
          user.buynow = 'Expired';

          // 5. Kirim notifikasi ke user dengan retry mechanism
          let retryCount = 0;
          const maxRetries = 3;

          while (retryCount < maxRetries) {
            try {
              await conn.sendMessage(jid, {
                text: `⚠️ Transaksi ${user.kode_unik} telah kadaluarsa (lebih dari 5 menit)`
              });
              break;
            } catch (sendError) {
              retryCount++;
              console.error(`[RETRY ${retryCount}] Gagal mengirim notifikasi ke ${jid}:`, sendError.message);
              if (retryCount < maxRetries) {
                await sleep(2000);
              }
            }
          }

          // 6. Bersihkan data transaksi
          delete user.lockedAccounts;
          delete user.kode_unik;
          delete user.qrbuy;
          delete user.pay;

          console.log(`[SELESAI] Transaksi ${user.kode_unik} telah dibersihkan`);
        }

      } catch (error) {
        console.error(`[ERROR KRITIS] Gagal memproses transaksi ${user.kode_unik}:`, {
          error: error.message,
          stack: error.stack
        });

        fs.appendFileSync('./transaction_errors.log',
          `${new Date().toISOString()} - ${user.kode_unik} - ${error.message}\n${error.stack}\n\n`);
      }
    }
  }
}

// Jalankan pengecekan transaksi pending saat startup
checkPendingTransactionsOnStartup();

async function checkPaymentStatus(user, m, conn, produk, kodeProduk, jumlah, totalHarga, kodeUnik, deskripsi, pesanInvoice) {
  const BATAS_WAKTU = 5 * 60 * 1000; // 5 menit
  const INTERVAL_CEK = 5000; // 15 detik
  const waktuMulai = Date.now();

  console.log(`[PEMBAYARAN] Memulai verifikasi pembayaran untuk ${kodeUnik}`);

  while (Date.now() - waktuMulai < BATAS_WAKTU) {
    try {
      // 1. Cek status pembayaran via API
      const response = await axios.get('https://gateway.okeconnect.com/api/mutasi/qris/OK2148982/650288317326127162148982OKCTD8073A07FA73356453190282B1CE56DD', {
        timeout: 5000
      });

      // 2. Jika pembayaran berhasil ditemukan
      if (response.data?.status === 'success') {
        const transaksi = response.data.data.find(item => item.amount == totalHarga);

        if (transaksi) {
          console.log(`[PEMBAYARAN] Pembayaran terverifikasi: ${kodeUnik}`);

          // 3. Verifikasi ketersediaan akun
          const stok = db_stock_list.find(s => s.code === kodeProduk);
          if (!stok) {
            throw new Error('Produk tidak ditemukan di stok');
          }

          // 4. Pastikan akun masih tersedia
          const akunValid = user.lockedAccounts.every(akunDibeli =>
            stok.accounts.some(akunStok =>
              akunStok.user === akunDibeli.user &&
              akunStok.pass === akunDibeli.pass
            )
          );

          if (!akunValid) {
            user.buynow = 'RefundNeeded';
            await conn.sendMessage(m.chat, {
              delete: pesanInvoice.key
            });
            throw new Error('Akun yang dibeli sudah tidak tersedia');
          }

          // 5. Hapus akun yang sudah dibeli dari stok
          stok.accounts = stok.accounts.filter(akunStok =>
            !user.lockedAccounts.some(akunDibeli =>
              akunDibeli.user === akunStok.user &&
              akunDibeli.pass === akunStok.pass
            )
          );
          stok.stockSold = (stok.stockSold || 0) + jumlah;
          stok.totalStock = stok.accounts.length;

          saveDB(db_stock_list);

          // 6. Kirim struk pembelian ke user
          let struk = `*╭────〔 TRANSAKSI SUKSES 〕─*\n` +
          `*┊・ ID TRX* : ${kodeUnik}\n` +
          `*┊・ Produk* : ${produk.name}\n` +
          `*┊・ Jumlah* : ${jumlah}\n` +
          `*┊・ Total Bayar* : Rp${totalHarga.toLocaleString('id-ID')}\n` +
          `*┊・ Deskripsi* : ${deskripsi}\n` +
          `*╰┈┈┈┈┈┈┈┈*\n\n`;

          user.lockedAccounts.forEach((akun, i) => {
            struk += `*╭────〔 AKUN ${i + 1} 〕─*\n` +
            `*┊・ Email: ${akun.user}\n` +
            `*┊・ Password: ${akun.pass}\n` +
            (akun.notes && akun.notes.length ? akun.notes.map((catatan, j) => `*┊・ Catatan ${j + 1}: ${catatan}\n`).join(''): '') +
            `*╰┈┈┈┈┈┈*\n\n`;
          });

          struk += '*– SIMPAN STRUK INI –*\n*– BOT TIDAK SIMPAN ULANG –*';

          await conn.sendMessage(m.sender, {
            text: struk
          }, {
            quoted: m
          });
          await conn.sendMessage(m.chat, {
            delete: pesanInvoice.key
          });

          // 7. Update status transaksi
          user.buynow = 'Success';
          addHistory(user, {
            type: 'buy',
            transactionID: kodeUnik,
            service: produk.name,
            productCode: kodeProduk,
            description: produk.description,
            status: 'Success',
            price: produk.price,
            amountBought: jumlah,
            totalPrice: totalHarga,
            initialBalance: user.money,
            date: new Date().toLocaleDateString('id-ID'),
            time: new Date().toLocaleTimeString('id-ID')
          });

          console.log(`[PEMBAYARAN] Transaksi ${kodeUnik} selesai`);
          return;
        }
      }
    } catch (error) {
      console.error(`[ERROR] Gagal verifikasi pembayaran ${kodeUnik}:`, error.message);

      // Hanya batalkan jika error fatal (bukan timeout)
      if (!error.message.includes('timeout')) {
        await batalkanTransaksi();
        return;
      }
    }

    // Cek jika waktu hampir habis (cek terakhir)
    if (Date.now() - waktuMulai >= BATAS_WAKTU - INTERVAL_CEK) {
      await batalkanTransaksi();
      return;
    }

    await sleep(INTERVAL_CEK);
  }

  async function batalkanTransaksi() {
    console.log(`[PEMBAYARAN] Pembayaran gagal untuk ${kodeUnik}`);

    // Bebaskan akun yang terkunci
    const stok = db_stock_list.find(s => s.code === kodeProduk);
    if (stok) {
      stok.accounts.forEach(akun => {
        if (akun.reservedUntil) delete akun.reservedUntil;
      });
      saveDB(db_stock_list);
    }

    // Update status transaksi
    user.buynow = 'Canceled';
    await conn.sendMessage(m.chat,
      {
        delete: pesanInvoice.key
      });
    await conn.sendMessage(m.sender,
      {
        text: '⏳ Transaksi dibatalkan karena tidak ada pembayaran dalam 5 menit.'
      },
      {
        quoted: m
      });

    console.log(`[PEMBAYARAN] Transaksi ${kodeUnik} dibatalkan`);
  }
}

module.exports = {
  async handler(chatUpdate) {
    if (global.db.data == null) await loadDatabase()
    this.msgqueque = this.msgqueque || []

    if (!chatUpdate) return
    this.pushMessage(chatUpdate.messages).catch(console.error)

    let m = chatUpdate.messages[chatUpdate.messages.length - 1]
    global.settings = global.db.data.settings
    global.fkontak = global.fkontak
    if (!m) return

    try {
      m = simple.smsg(this, m) || m
      if (!m) return
      try {
        let user = global.db.data.users[m.sender]
        if (typeof user !== 'object') global.db.data.users[m.sender] = {}
        if (user) {
          if (!isNumber(user.money)) user.money = 0
          if (!('registered' in user)) user.registered = false
          if (!user.registered) {
            if (!('name' in user)) user.name = m.name
            if (!('id' in user)) user.id = -1
            if (!isNumber(user.regTime)) user.regTime = -1
          }
          if (!('banned' in user)) user.banned = false
          if (!('moderator' in user)) user.moderator = false
          if (!user.acc) user.acc = false
          if (!user.acc) user.end = false
          if (!('session' in user)) user.session = ''
          if (!('buynow' in user)) user.buynow = ''
          if (!('qrbuy' in user)) user.qrbuy = ''
          if (!('pay' in user)) user.pay = ''
          if (!('depo' in user)) user.depo = ''
          if (!('firstuse' in user)) user.firstuse = true
        } else global.db.data.users[m.sender] = {
          money: 0,
          registered: false,
          name: m.name,
          id: -1,
          regTime: -1,
          banned: false,
          moderator: false,
          acc: 0,
          end: 0,
          session: '',
          buynow: '',
          depo: '',
          firstuse: true,
        }
        let chat = global.db.data.chats[m.chat]
        if (typeof chat !== 'object') global.db.data.chats[m.chat] = {}
        if (chat) {
          if (!('isBanned' in chat)) chat.isBanned = false
          if (!('welcome' in chat)) chat.welcome = true
          if (!('autoread' in chat)) chat.autoread = true
          if (!('detect' in chat)) chat.detect = false
          if (!('sWelcome' in chat)) chat.sWelcome = 'Selamat datang @user!'
          if (!('sBye' in chat)) chat.sBye = ''
          if (!('sPromote' in chat)) chat.sPromote = '@user telah di promote'
          if (!('sDemote' in chat)) chat.sDemote = '@user telah di demote'
          if (!('delete' in chat)) chat.delete = true
          if (!('antiVirtex' in chat)) chat.antiVirtex = false
          if (!('antiLink' in chat)) chat.antiLink = false
          if (!('badword' in chat)) chat.badword = false
          if (!('antiSpam' in chat)) chat.antiSpam = false
          if (!('freply' in chat)) chat.freply = false
          if (!('antiSticker' in chat)) chat.antiSticker = false
          if (!('anticall' in chat)) chat.antiCall = true
          if (!('stiker' in chat)) chat.stiker = false
          if (!('viewonce' in chat)) chat.viewonce = false
          if (!('useDocument' in chat)) chat.useDocument = false
          if (!('antiToxic' in chat)) chat.antiToxic = false
          if (!isNumber(chat.expired)) chat.expired = 0
        } else global.db.data.chats[m.chat] = {
          isBanned: false,
          welcome: true,
          autoread: true,
          detect: false,
          sWelcome: '',
          sBye: '',
          sPromote: '*promoted new admin:* @user',
          sDemote: '*demoted from admin:* @user',
          delete: true,
          antiLink: true,
          stiker: false,
          antiSticker: true,
          antiCall: true,
          antiSpam: true,
          freply: false,
          viewonce: false,
          useDocument: true,
          antiToxic: true,
          expired: 0,
        }
        let settings = global.db.data.settings[this.user.jid]
        if (typeof settings !== 'object') global.db.data.settings[this.user.jid] = {}
        if (settings) {
          if (!('self' in settings)) settings.self = true
          if (!('autoread' in settings)) settings.autoread = true
          if (!('restrict' in settings)) settings.restrict = true
          if (!('autorestart' in settings)) settings.autorestart = true
          if (!('restartDB' in settings)) settings.restartDB = 0
          if (!isNumber(settings.status)) settings.status = 0
          if (!('anticall' in settings)) settings.anticall = true
          if (!('clear' in settings)) settings.clear = true
          if (!isNumber(settings.clearTime)) settings.clearTime = 0
          if (!('freply' in settings)) settings.freply = true
        } else global.db.data.settings[this.user.jid] = {
          self: true,
          autoread: true,
          restrict: true,
          autorestart: true,
          restartDB: 0,
          status: 0,
          anticall: true,
          clear: true,
          clearTime: 0,
          freply: true
        }
      } catch (e) {
        console.error(e)
      }
      if (typeof m.text !== 'string') m.text = ''

      const isROwner = [conn.decodeJid(global.conn.user.id),
        ...globalSettings.owner]
      .map(v => (typeof v === 'string' ? v.replace(/[^0-9]/g, '') + '@s.whatsapp.net': null))
      .filter(Boolean)
      .includes(m.sender);
      const isOwner = isROwner || m.fromMe
      const isMods = global.db.data.users[m.sender].moderator
      const isBans = global.db.data.users[m.sender].banned
      if (isROwner) {
        db.data.users[m.sender].moderator = true
      }
      if (!isROwner && isBans) return

      if (opts['autoread']) await this.readMessages([m.key])
      if (opts['nyimak']) return
      if (!m.fromMe && !global.db.data.users[m.sender].moderator && opts['self']) return

      if (opts['pconly'] && m.chat.endsWith('g.us')) return
      if (opts['gconly'] && !m.fromMe && !m.chat.endsWith('g.us')) return
      if (opts['swonly'] && m.chat !== 'status@broadcast') return
      if (opts['queque'] && m.text && !isMods) {
        let queque = this.msgqueque,
        time = 1000 * 5

        const previousID = queque[queque.length - 1]
        queque.push(m.id || m.key.id)
        setInterval(async function () {
          if (queque.indexOf(previousID) === -1) clearInterval(this)
          else await delay(time)
        },
          time)
      }

      let usedPrefix
      let _user = global.db.data && global.db.data.users && global.db.data.users[m.sender]

      const groupMetadata = (m.isGroup ? (conn.chats[m.chat] || {}).metadata: {}) || {}
      const participants = (m.isGroup ? groupMetadata.participants: []) || []
      const user = global.db.data.users[m.sender];
      const botNumber = await conn.decodeJid(conn.user.id);
      const isCreator = [botNumber, ...globalSettings.owner]
      .map(v => (typeof v === 'string' ? v.replace(/[^0-9]/g, '') + '@s.whatsapp.net': null))
      .filter(Boolean)
      .includes(m.sender);
      const isRegistered = user.registered
      const groupName = m.isGroup ? groupMetadata.subject: "";
      const groupAdmins = m.isGroup ? await conn.getGroupAdmins(participants): ''
      const isGroup = m.isGroup
      const isBotAdmins = m.isGroup ? groupAdmins.includes(botNumber): false
      const isAdmins = m.isGroup ? groupAdmins.includes(m.sender): false
      const bot = (m.isGroup ? participants.find(u => conn.decodeJid(u.id) == this.user.jid): {}) || {}
      const isRAdmin = user && user.admin == 'superadmin' || false
      const isAdmin = isRAdmin || user && user.admin == 'admin' || false
      const isBotAdmin = bot && bot.admin || false

      // Custom Case By Zrawh
      const currentDate = new Date().toLocaleDateString('id-ID',
        {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'Asia/Jakarta'
        });

      const currentTime = new Date().toLocaleTimeString('id-ID',
        {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Jakarta'
        });
      var body = (m.mtype === 'conversation') ? m.message.conversation:
      (m.mtype == 'reactionMessage') ? m.message.reactionMessage:
      (m.mtype == 'imageMessage') ? m.message.imageMessage.caption:
      (m.mtype == 'videoMessage') ? m.message.videoMessage.caption:
      (m.mtype == 'extendedTextMessage') ? m.message.extendedTextMessage.text:
      (m.mtype == 'buttonsResponseMessage') ? m.message.buttonsResponseMessage.selectedButtonId:
      (m.mtype == 'listResponseMessage') ? m.message.listResponseMessage.singleSelectnewReply.selectedRowId:
      (m.mtype == 'templateButtonnewReplyMessage') ? m.message.templateButtonnewReplyMessage.selectedId:
      (m.mtype === 'messageContextInfo') ? (m.message.buttonsResponseMessage?.selectedButtonId || m.message.listResponseMessage?.singleSelectnewReply.selectedRowId || m.text): '';
      const argscmd = body.trim().split(/\s+/);
      const args = body.trim().split(/ +/).slice(1)
      const command = argscmd.shift().toLowerCase();
      const pric = '#';
      const isCommand = body.startsWith(pric);
      if (isCommand) {
        if (!user.registered) {
          let id = Math.random().toString(36).substr(2, 8).toUpperCase();
          let name = conn.getName(m.sender);
          let wa = m.sender.split("@")[0];
          let saldo = 0;

          user.name = name;
          user.id = id;
          user.money = saldo;
          user.regTime = +new Date();
          user.registered = true;
        }
        let actualCommand = command.substring(pric.length);
        switch (actualCommand) {
          case 'getid':
            conn.sendMessage(m.chat, {
              text: m.chat
            });
            break
          case 'tes':
            if (!args.join(' ') || args.join(' ').trim() === "") {
              return m.reply(`Format salah. Gunakan: ${pric}tes <pesan>`);
            }
            conn.sendMessage("120363405920909621@g.us", {
              text: args.join(' ')
            });
            break
          case 'hidetag':
            if (!isAdmins) return m.reply(globalSettings.mess.admin);
            if (!args.join(' ') || args.join(' ').trim() === "") {
              return m.reply(`Format salah. Gunakan: ${pric}hidetag <pesan>`);
            }
            conn.sendMessage(m.chat, {
              text: args.join(' '), mentions: participants.map(a => a.id)
            });
            break
          case 'send':
            if (!isCreator) return m.reply(globalSettings.mess.owner);
            if (m.isGroup) return m.reply(globalSettings.mess.private);

            const texto = m.text.split(' ').slice(1);
            if (texto.length < 2) return m.reply(`Format salah. Gunakan: ${pric}send <nomor> <pesan>`);

            const nomortarget = texto[0];
            const messagenya = texto.slice(1).join(' ');

            if (!/^\d+$/.test(nomortarget)) return m.reply("Harap berikan nomor yang valid!");

            try {
              await conn.sendMessage(`${nomortarget}@s.whatsapp.net`, {
                text: `${messagenya}\n\nNote: untuk membalas chat admin bisa menggunakan command \`${pric}msg pesanmu\``
              });
              m.reply(`Pesan berhasil terkirim ke wa.me/${nomortarget}.`);
            } catch (error) {
              console.error('Error sending message:', error);
              m.reply('Gagal mengirim pesan.');
            }
            break
          case 'msg':
            if (m.isGroup) return m.reply(globalSettings.mess.private);
            const textodo = m.text.split(' ').slice(1);
            if (textodo.length < 1) return m.reply(`Format salah. Gunakan: ${pric}msg <pesan>`);
            const pesannya = textodo.join(' ');
            try {
              globalSettings.owner.forEach(function(number) {
                conn.sendMessage(number + '@s.whatsapp.net', {
                  'text': `*Pesan dari ${user.name}*\n*WA:* wa.me/${m.sender.split("@")[0]}\n\nPesan: ${pesannya}`,
                  'quoted': m.chat
                });
              });
              m.reply('Pesan berhasil terkirim ke admin.');
            } catch (error) {
              console.error('Error sending message:', error);
              m.reply('Gagal mengirim pesan.');
            }
            break
          case 'claimgaransi':
            if (m.isGroup) return m.reply(globalSettings.mess.private);
            if (user.session === 'claimgaransi') {
              conn.sendMessage(m.chat, {
                text: `Harap selesaikan claim garansi sebelumnya terlebih dahulu.`
              });
            } else {
              conn.sendMessage(m.chat, {
                text: `_Harap mengisi data dengan benar._ \n\n_Wiped: ketika login, muncul notif signup._\n_Incorrect password: ketika login, muncul notif kata sandi salah_.`
              });
              await new Promise(resolve => setTimeout(resolve, 1500));
              user.session = 'claimgaransi';
              conn.sendMessage(m.chat, {
                text: `FORMAT YOUTUBE\n\n*Email:*\n*Password:*\n*Tanggal beli:*\n*Sisa durasi:*\n*Incorrect password/wiped:* `
              });
            }
            break
          case 'liststock':
          case 'liststok':
            if (!isCreator) return m.reply(globalSettings.mess.owner);
            const productCodenya = args[0];
            if (!productCodenya) return m.reply(`Format salah. Gunakan: ${pric}liststok <kode>`);

            const stockItem = db_stock_list.find(stock => stock.code === productCodenya.toLowerCase());
            if (!stockItem) return m.reply("Tidak ada produk yang ditemukan dengan kode itu.");

            let responseMessage = `*╭────〔 ACCOUNT LIST 〕─*\n` +
            `*┊・ Item* : ${stockItem.name}\n` +
            `*┊・ Kode*: ${stockItem.code}\n` +
            `*┊・ Total Stok*: ${stockItem.totalStock}\n` +
            `*┊・ Terjual*: ${stockItem.stockSold || 0}\n`;
            stockItem.accounts.forEach((account, index) => {
              responseMessage += `*┊・ Stok ${index + 1}*: ${account.user}:${account.pass} (Tanggal: ${new Date(account.date).toLocaleDateString('id-ID')})\n`;
              if (account.notes && account.notes.length) {
                account.notes.forEach((note, noteIndex) => {
                  responseMessage += `*┊・ Catatan ${noteIndex + 1}*: ${note}\n`;
                });
              }
            });
            responseMessage += '*╰┈┈┈┈┈┈┈┈*';
            m.reply(responseMessage);
            break
          case 'wd':
            if (!isCreator) return m.reply(globalSettings.mess.owner); // ✅ Hanya owner
            if (m.isGroup) return m.reply(globalSettings.mess.private); // ✅ Hanya private chat

            const [codeArg,
              targetArg] = args;

            if (!codeArg || !targetArg) {
              return m.reply(`⚠️ Format salah.\nGunakan: ${pric}wd <code> <target>\n\nContoh: ${pric}wd PLN50 081234567890`);
            }

            // Validasi target harus angka dan minimal 8 digit
            if (!/^\d{8,20}$/.test(targetArg)) {
              return m.reply(`⚠️ Target harus berupa angka dan minimal 8 digit.\nContoh: 081234567890 atau ID pelanggan PLN.`);
            }

            const aapiKey = '15xyWfE4x76sm4Q1yIfadFg7wvQwlyNna8sL8nM77UuUNXJsDpK283ISQqEMRb1C5ArKyoQ16qSXz4LgeJC8iTnhU1kRY3wcIjiy';
            const reffId = Math.random().toString(36).substr(2, 10).toUpperCase();

            try {
              const response = await axios.post('https://atlantich2h.com/transaksi/create', qs.stringify({
                api_key: aapiKey,
                code: codeArg,
                reff_id: reffId,
                target: targetArg
              }), {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded'
                }
              });

              console.log("=== LOG RESPONSE WD ===");
              console.log(response.data);
              console.log("=======================");

              if (response.data.status) {
                const data = response.data.data;
                let message = `*✅ TRANSAKSI BERHASIL DIBUAT!*\n\n` +
                `- Code: *${codeArg}*\n` +
                `- Target: *${targetArg}*\n` +
                `- Reff ID: *${reffId}*\n` +
                `- Status: *${data.status || 'N/A'}*\n\n` +
                `Silakan cek detail di panel Atlantic H2H. 🚀`;
                m.reply(message);
              } else {
                m.reply(`⚠️ Gagal membuat transaksi.\nPesan: ${response.data.message || 'Tidak diketahui'}`);
              }

            } catch (err) {
              console.error('❌ Error transaksi WD:', err);
              m.reply('❌ Terjadi kesalahan saat membuat transaksi. (Error server Atlantic H2H atau parameter tidak valid). Silakan coba lagi atau hubungi admin.');
            }
            break
case 'saldo':
    if (!isCreator) return m.reply(globalSettings.mess.owner); // Restrict to owner only
    if (m.isGroup) return m.reply(globalSettings.mess.private); // Only in private chat

    try {
        const apiKey = globalSettings.apikey_pay || '15xyWfE4x76sm4Q1yIfadFg7wvQwlyNna8sL8nM77UuUNXJsDpK283ISQqEMRb1C5ArKyoQ16qSXz4LgeJC8iTnhU1kRY3wcIjiy';
        const response = await axios.post('https://atlantich2h.com/get_profile', qs.stringify({
            api_key: apiKey
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (response.data.status === 'true') {
            const balance = response.data.data.balance;
            m.reply(`*Saldo Payment Gateway*: Rp${parseInt(balance).toLocaleString('id-ID')}`);
        } else {
            m.reply(`⚠️ Gagal mendapatkan saldo.\nPesan: ${response.data.message || 'Tidak diketahui'}`);
        }
    } catch (error) {
        console.error('❌ Error checking balance:', error.message);
        m.reply('❌ Terjadi kesalahan saat memeriksa saldo. Silakan coba lagi atau hubungi admin.');
    }
    break
          case 'addstock':
          case 'addstok':
            if (!isCreator) return m.reply(globalSettings.mess.owner);
            if (m.isGroup) return m.reply(globalSettings.mess.private);
            const stockInput = args.join(' ');
            const stockRegex = /^([A-Za-z0-9]+)\|([^|]+)\|(\d+)\|([^|]+)\|([^|]+)\|([^|]+)(?:\|([^|]*))*$/;
            if (!stockRegex.test(stockInput)) {
              return m.reply(`Format salah. Gunakan: ${pric}addstok <kode>|<nama>|<harga>|<deskripsi>|<email>|<password>|<note1>[|<note2>|...]`);
            }

            try {
              const newStock = addStock(stockInput, db_stock_list);
              const newStockIndex = db_stock_list.findIndex(stock => stock.code === newStock.code);
              const addedStock = db_stock_list[newStockIndex];
              let message = `*╭────〔 SUKSES MENAMBAHKAN STOK 〕─*\n` +
              `*┊・ Harga*: Rp${addedStock.price.toLocaleString('id-ID')}\n` +
              `*┊・ Item* : ${addedStock.name}\n` +
              `*┊・ Kode*: ${addedStock.code}\n` +
              `*┊・ Total Stok*: ${addedStock.totalStock}\n` +
              `*┊・ Desk*: ${addedStock.description}\n` +
              `*┊・ Akun*: ${addedStock.accounts[addedStock.accounts.length - 1].user}\n` +
              (addedStock.accounts[addedStock.accounts.length - 1].notes.length ?
                addedStock.accounts[addedStock.accounts.length - 1].notes.map((note, i) => `*┊・ Catatan ${i + 1}*: ${note}\n`).join(''): '') +
              `*╰┈┈┈┈┈┈┈┈*`;
              m.reply(message);

              // Broadcast to WhatsApp channel
              const channelId = "120363405920909621@g.us";
              const restockTime = `${new Date().toLocaleDateString('id-ID')} ${new Date().toLocaleTimeString('id-ID')}`;
              const broadcastMessage = `✅ Restock Sukses!\n📊 Total Akun Ditambahkan: 1 ${addedStock.code}\n🕒 Waktu Restock: ${restockTime}\n🔥 Segera Ambil Sebelum Habis!\n\nCek Stok Via Bot\nwa.me/6282250557228?text=%23stok\n\nBeli ${addedStock.name} Otomatis Via Bot (Sesuaikan Jumlah Pembelian)\nhttps://wa.me/6282250557228?text=%23buy%20${addedStock.code}%201`;

              try {
                await conn.sendMessage(channelId, {
                  text: broadcastMessage
                });
                console.log(`[BROADCAST] Pesan restock berhasil dikirim ke channel ${channelId}`);
              } catch (error) {
                console.error(`[BROADCAST] Gagal mengirim pesan ke channel ${channelId}:`, error.message);
              }
            } catch (error) {
              m.reply(`Gagal menambahkan stok: ${error.message}`);
            }
            break
          case 'addbulk':
            if (!isCreator) return m.reply(globalSettings.mess.owner);
            if (m.isGroup) return m.reply(globalSettings.mess.private);
            const bulkInput = args.join(' ');
            const bulkRegex = /^([A-Za-z0-9]+)\|([^|]+)\|(\d+)\|([^|]+)\|(.+)$/;
            if (!bulkRegex.test(bulkInput)) {
              return m.reply(`Format salah. Gunakan: ${pric}addbulk <kode>|<nama>|<harga>|<deskripsi>|<email1>|<pass1>|<email2>|<pass2>|...`);
            }

            const [,
              bulkCode,
              bulkName,
              bulkPrice,
              bulkDesc,
              bulkAccounts] = bulkInput.match(bulkRegex);
            let db = db_stock_list;
            let product = db.find(p => p.code === bulkCode.toLowerCase());
            const date = new Date().toISOString();
            let added = 0;

            if (!product) {
              product = {
                code: bulkCode.toLowerCase(),
                name: bulkName,
                price: parseInt(bulkPrice),
                description: bulkDesc,
                stockSold: 0,
                totalStock: 0,
                accounts: []
              };
              db.push(product);
            }

            const accountData = bulkAccounts.split('|');
            for (let i = 0; i < accountData.length; i += 2) {
              if (accountData[i] && accountData[i + 1]) {
                product.accounts.push({
                  user: accountData[i], pass: accountData[i + 1], date
                });
                added++;
              }
            }

            product.totalStock += added;
            saveDB(db);

            // Broadcast to WhatsApp channel
            const channelId = "120363405920909621@g.us";
            const restockTime = `${new Date().toLocaleDateString('id-ID')} ${new Date().toLocaleTimeString('id-ID')}`;
            const broadcastMessage = `✅ Restock Sukses!\n📊 Total Akun Ditambahkan: ${added} ${bulkCode}\n🕒 Waktu Restock: ${restockTime}\n🔥 Segera Ambil Sebelum Habis!\n\nCek Stok Via Bot\nwa.me/6285173317723?text=%23stok\n\nBeli ${bulkName} Otomatis Via Bot (Sesuaikan Jumlah Pembelian)\nhttps://wa.me/6285173317723?text=%23buy%20${bulkCode}%201`;

            try {
              await conn.sendMessage(channelId, {
                text: broadcastMessage
              });
              console.log(`[BROADCAST] Pesan restock berhasil dikirim ke channel ${channelId}`);
            } catch (error) {
              console.error(`[BROADCAST] Gagal mengirim pesan ke channel ${channelId}:`, error.message);
            }

            m.reply(`✅ Berhasil menambahkan ${added} akun ke ${bulkName}`);
            break
          case 'hapusbulk':
            if (!isCreator) return m.reply(globalSettings.mess.owner);
            const hapusInput = args.join(' ');
            const hapusRegex = /^([A-Za-z0-9]+)\|(\d+-\d+)$/;
            if (!hapusRegex.test(hapusInput)) {
              return m.reply(`Format salah. Gunakan: ${pric}hapusbulk <kode>|<awal-akhir>`);
            }

            const [,
              hapusCode,
              hapusRange] = hapusInput.match(hapusRegex);
            const [awal,
              akhir] = hapusRange.split('-').map(n => parseInt(n));
            const from = awal - 1;
            const to = akhir - 1;
            let hapusDb = db_stock_list;
            let hapusProduct = hapusDb.find(p => p.code === hapusCode.toLowerCase());
            if (!hapusProduct) return m.reply('❌ Produk tidak ditemukan.');

            if (from < 0 || to >= hapusProduct.accounts.length || from > to)
              return m.reply('❌ Rentang indeks tidak valid.');

            hapusProduct.accounts.splice(from, to - from + 1);
            hapusProduct.totalStock = hapusProduct.accounts.length;
            saveDB(hapusDb);
            m.reply(`✅ Berhasil menghapus stok posisi ${awal} sampai ${akhir}`);
            break
          case 'exportstok':
            if (!isCreator) return m.reply(globalSettings.mess.owner);
            const exportInput = args.join(' ');
            const exportRegex = /^([A-Za-z0-9]+)$/;
            if (!exportRegex.test(exportInput)) {
              return m.reply(`Format salah. Gunakan: ${pric}exportstok <kode>`);
            }

            const exportCode = exportInput;
            let exportDb = db_stock_list;
            let exportProduct = exportDb.find(p => p.code === exportCode.toLowerCase());
            if (!exportProduct) return m.reply('❌ Produk tidak ditemukan.');

            const lines = exportProduct.accounts.map(a => `${a.user}|${a.pass}`);
            const output = lines.join('\n');
            const filePath = './stok-export.txt';
            fs.writeFileSync(filePath, output);
            m.reply(`✅ Export berhasil. File: stok-export.txt`);
            break
          case 'delstock':
          case 'delstok':
            if (!isCreator) return m.reply(globalSettings.mess.owner);

            if (args.length !== 1) {
              return m.reply(`Format salah. Gunakan: ${pric}delstok <kode>`);
            }

            const productCodes = args[0];
            const deletedStock = delStock(productCodes, db_stock_list);
            if (!deletedStock) {
              return m.reply('Stok tidak ditemukan dengan kode produk yang diberikan.');
            }
            m.reply(`Stok dengan kode produk ${productCodes} berhasil dihapus.`);
            break
          case 'delaccount':
          case 'delakun':
            if (!isCreator) return m.reply(globalSettings.mess.owner);

            if (args.length !== 2) {
              return m.reply(`Format salah. Gunakan: ${pric}delakun <kode> <indeks>`);
            }

            const productCode = args[0];
            const accountIndex = parseInt(args[1]);
            if (isNaN(accountIndex)) {
              return m.reply('Indeks harus berupa angka.');
            }

            const deletedAccount = delAccountFromStock(productCode, accountIndex, db_stock_list);
            if (!deletedAccount) {
              return m.reply('Tidak ditemukan akun dengan indeks yang diberikan untuk kode produk yang ditentukan.');
            }

            m.reply(`Akun pada posisi ${accountIndex} untuk kode produk ${productCode} telah berhasil dihapus.`);
            break
          case 'setstock':
          case 'setstok':
            if (!isCreator) return m.reply(globalSettings.mess.owner);
            if (m.isGroup) return m.reply(globalSettings.mess.private);
            const setStockInput = args.join(' ');
            const stockUpdateRegex = /^([A-Za-z0-9]+)\s((?:[^|\n]+\|[^|\n]+\|[^|\n]*(?:\|[^|\n]*)*\n?)*)$/;

            if (!stockUpdateRegex.test(setStockInput)) {
              return m.reply(`Format salah. Gunakan: ${pric}setstok <kode> <email1>|<password1>\n<email2>|<password2>`);
            }

            let [,
              productcode,
              accountsInput] = setStockInput.match(stockUpdateRegex);
            const accounts = accountsInput.trim().split('\n').map(account => account.trim());

            const result = setStock(productcode, accounts, db_stock_list);
            if (typeof result === 'string') {
              m.reply(result);
            } else {
              let messageSetStock = `*╭────〔 SUKSES MENGUBAH STOK 〕─*\n` +
              `*┊・ Item* : ${result.name}\n` +
              `*┊・ Kode*: ${result.code}\n` +
              `*┊・ Total Stok*: ${result.totalStock}\n`;
              messageSetStock += '*╰┈┈┈┈┈┈┈┈*';
              m.reply(messageSetStock);
            }
            break
          case 'setjudul':
            if (!isCreator) return m.reply(globalSettings.mess.owner);

            if (args.length < 2) {
              return m.reply(`Format salah. Gunakan: ${pric}setjudul <kode> <judul>`);
            }

            const setjudulCode = args[0];
            const newTitle = args.slice(1).join(' ');
            if (newTitle.includes('\n')) {
              return m.reply('Judul stock tidak boleh mengandung baris baru (line break).');
            }
            const titleChanged = changeTitle(setjudulCode, newTitle, db_stock_list);

            if (titleChanged) {
              m.reply(`Judul stock dengan kode '${setjudulCode}' berhasil diubah menjadi '${newTitle}'.`);
            } else {
              m.reply(`Gagal mengubah judul stock. Kode stock '${setjudulCode}' tidak ditemukan.`);
            }
            break
          case 'setharga':
            if (!isCreator) return m.reply(globalSettings.mess.owner);

            if (args.length < 2) {
              return m.reply(`Format salah. Gunakan: ${pric}setharga <kode> <harga>`);
            }

            const code = args[0];
            const newPrice = parseInt(args[1]);

            if (isNaN(newPrice) || newPrice <= 0) {
              return m.reply('Harga harus berupa angka positif yang valid.');
            }
            const priceChanged = changePrice(code, newPrice, db_stock_list);

            if (priceChanged) {
              m.reply(`Harga stock dengan kode '${code}' berhasil diubah menjadi '${newPrice}'.`);
            } else {
              m.reply(`Gagal mengubah harga stock. Kode stock '${code}' tidak ditemukan.`);
            }
            break
          case 'setdesk':
            if (!isCreator) return m.reply(globalSettings.mess.owner);

            if (args.length < 2) {
              return m.reply(`Format salah. Gunakan: ${pric}setdesk <kode> <deskripsi>`);
            }

            const setDescCode = args[0];
            const newDesc = args.slice(1).join(' ');
            const DescChanged = changeDescription(setDescCode, newDesc, db_stock_list);

            if (DescChanged) {
              m.reply(`Deskripsi stock dengan kode '${setDescCode}' berhasil diubah menjadi '${newDesc}'.`);
            } else {
              m.reply(`Gagal mengubah Deskripsi stock. Kode stock '${setDescCode}' tidak ditemukan.`);
            }
            break
          case 'buy':
            const [beliCode,
              beliAmountStr] = args;
            const beliAmount = parseInt(beliAmountStr);

            if (args.length !== 2) {
              return m.reply(`Format salah. Gunakan: ${pric}buy <kode> <jumlah>`);
            }

            if (user.buynow === 'Pending') {
              return m.reply(`Maaf mohon selesaikan pembayaran anda sebelumnya.`);
            }

            if (!beliCode || isNaN(beliAmount) || beliAmount <= 0) {
              return m.reply(`Format salah. Gunakan: ${pric}buy <kode> <jumlah>`);
            }

            const beliStock = db_stock_list.find(stock => stock.code === beliCode);
            if (!beliStock) {
              return m.reply(`Gagal membeli. Produk dengan kode '${beliCode}' tidak ditemukan.`);
            }

            // Bersihkan reservasi yang expired
            let cleaned = false;
            beliStock.accounts = beliStock.accounts.map(acc => {
              if (acc.reservedUntil && new Date(acc.reservedUntil) < new Date()) {
                delete acc.reservedUntil;
                cleaned = true;
              }
              return acc;
            });
            if (cleaned) {
              saveDB(db_stock_list);
            }

            const availableAccounts = beliStock.accounts.filter(acc => !acc.reservedUntil);
            if (availableAccounts.length < beliAmount) {
              return m.reply(`Maaf, stok dengan kode ${beliCode} hanya tersedia ${availableAccounts.length} stok yang belum direservasi.`);
            }

            const hargaAwal = beliStock.price * beliAmount;
            if (beliStock.price < 2000 && hargaAwal < 2000) {
              const minimalQty = Math.ceil(2000 / beliStock.price);
              return m.reply(`⚠️ Harga produk ini Rp${beliStock.price.toLocaleString('id-ID')}. Pembelian minimal harus Rp2.000.\nSilakan beli minimal *${minimalQty}* akun.`);
            }

            const totalhargaTemp = hargaAwal + Math.floor(Math.random() * 999) + 1;
            const totalharga = Math.max(totalhargaTemp, 2000);
            const kode_unik = Math.random().toString(36).substr(2, 15).toUpperCase().padEnd(15, '0');
            const reservedUntil = new Date(Date.now() + 5 * 60 * 1000);
            const formatDesc = beliStock.description.replace(/\n/g, '\n*┊・* ');
            const selectedAccounts = availableAccounts.slice(0, beliAmount);

            selectedAccounts.forEach(acc => {
              acc.reservedUntil = reservedUntil.toISOString();
              acc.productCode = beliCode;
            });
            saveDB(db_stock_list);

            user.lockedAccounts = selectedAccounts.map(acc => ({
              ...acc
            }));
            user.kode_unik = kode_unik;
            user.buynow = 'Pending';
            user.pay = totalharga;

            try {
              const apiKey = '15xyWfE4x76sm4Q1yIfadFg7wvQwlyNna8sL8nM77UuUNXJsDpK283ISQqEMRb1C5ArKyoQ16qSXz4LgeJC8iTnhU1kRY3wcIjiy';
              const createResponse = await axios.post('https://atlantich2h.com/deposit/create', qs.stringify({
                api_key: apiKey,
                reff_id: kode_unik,
                nominal: totalharga,
                type: 'ewallet',
                metode: 'qris'
              }), {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded'
                }
              });

              if (!createResponse.data.status || createResponse.data.code !== 200) {
                throw new Error('Gagal membuat deposit: ' + JSON.stringify(createResponse.data));
              }

              const depositData = createResponse.data.data;
              user.depositId = depositData.id;
              user.qrbuy = depositData.qr_string;
              user.expiredAt = depositData.expired_at;

              const caption = `\`DETAIL PEMBAYARAN [Pending]\`\n\n` +
              `- ID PAY: ${kode_unik}\n` +
              `- PRODUK: ${beliStock.name} (${beliCode})\n` +
              `- HARGA: Rp${beliStock.price.toLocaleString('id-ID')} x ${beliAmount}\n` +
              `- TOTAL: Rp${totalharga.toLocaleString('id-ID')}\n` +
              `- BATAS WAKTU: 5 Menit\n`;

              try {
                const QRCode = require('qrcode');
                const qrBuffer = await QRCode.toBuffer(depositData.qr_string);

                const invoiceMessages = await conn.sendMessage(
                  m.chat,
                  {
                    image: qrBuffer, caption: caption + `\n*Scan QR di atas untuk pembayaran*`
                  }
                );

                let attempts = 0;
                const maxAttempts = 36;

                const checkInterval = setInterval(async () => {
                  attempts++;

                  try {
                    const statusResponse = await axios.post('https://atlantich2h.com/deposit/status', qs.stringify({
                      api_key: apiKey,
                      id: user.depositId
                    }), {
                      headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                      }
                    });

                    console.log(`=== LOG STATUS CHECK (Attempt ${attempts}) ===`);
                    console.log(statusResponse.data);
                    console.log("==========================================");

                    if (statusResponse.data.status &&
                      (statusResponse.data.data.status === 'success' || statusResponse.data.data.status === 'processing')) {

                      clearInterval(checkInterval);

                      try {
                        const instantRes = await axios.post('https://atlantich2h.com/deposit/instant', qs.stringify({
                          api_key: apiKey,
                          id: user.depositId,
                          action: true
                        }), {
                          headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                          }
                        });

                        console.log("=== LOG RESPONSE INSTANT CONFIRMATION ===");
                        console.log(instantRes.data);
                        console.log("=========================================");
                      } catch (err) {
                        console.error("❌ Gagal konfirmasi instant:", err.message);
                      }

                      user.buynow = 'Done';
                      delete user.qrbuy;
                      delete user.depositId;

                      const beliStockFinal = db_stock_list.find(stock => stock.code === beliCode);
                      if (beliStockFinal) {
                        user.lockedAccounts.forEach(acc => {
                          const index = beliStockFinal.accounts.findIndex(a => a.user === acc.user && a.pass === acc.pass);
                          if (index !== -1) {
                            beliStockFinal.accounts.splice(index, 1);
                          }
                        });

                        beliStockFinal.stockSold = (beliStockFinal.stockSold || 0) + user.lockedAccounts.length;
                        beliStockFinal.totalStock = beliStockFinal.accounts.length;

                        saveDB(db_stock_list);
                      }

                      const akunList = user.lockedAccounts.map((acc, i) => `*${i + 1}.* ${acc.user}|${acc.pass}`).join('\n');
                      // Construct the new success message format
                      let successMessage = `*╭────〔 TRANSAKSI SUKSES 〕─*\n` +
                      `*┊・ ID TRX* : ${kode_unik}\n` +
                      `*┊・ Produk* : ${beliStockFinal.name}\n` +
                      `*┊・ Jumlah* : ${beliAmount}\n` +
                      `*┊・ Total Bayar* : Rp${totalharga.toLocaleString('id-ID')}\n` +
                      `*┊・ Deskripsi* : ${formatDesc}\n` +
                      `*╰┈┈┈┈┈┈┈┈*\n\n`;

                      user.lockedAccounts.forEach((akun, i) => {
                        successMessage += `*╭────〔 AKUN ${i + 1} 〕─*\n` +
                        `*┊・ Email: ${akun.user}\n` +
                        `*┊・ Password: ${akun.pass}\n` +
                        (akun.notes && akun.notes.length ? akun.notes.map((catatan, j) => `*┊・ Catatan ${j + 1}: ${catatan}\n`).join(''): '') +
                        `*╰┈┈┈┈┈┈*\n\n`;
                      });

                      successMessage += '*– SIMPAN STRUK INI –*\n*– BOT TIDAK SIMPAN ULANG –*';

                      await conn.sendMessage(m.chat,
                        {
                          text: successMessage
                        },
                        {
                          quoted: invoiceMessages
                        });

                      delete user.lockedAccounts;

                      // Update transaction history
                      addHistory(user, {
                        type: 'buy',
                        transactionID: kode_unik,
                        service: beliStockFinal.name,
                        productCode: beliCode,
                        description: beliStockFinal.description,
                        status: 'Success',
                        price: beliStockFinal.price,
                        amountBought: beliAmount,
                        totalPrice: totalharga,
                        initialBalance: user.money,
                        date: new Date().toLocaleDateString('id-ID'),
                        time: new Date().toLocaleTimeString('id-ID')
                      });

                    }

                    if (attempts >= maxAttempts) {
                      clearInterval(checkInterval);
                      console.log("❌ Waktu cek status habis. Pembayaran tidak diterima.");
                      m.reply('⚠️ Batas waktu pembayaran habis. Silakan coba beli ulang.');
                    }

                  } catch (err) {
                    console.error(`❌ Error cek status (Attempt ${attempts}):`, err.message);
                  }

                },
                  5000);

              } catch (qrError) {
                console.error('❌ Error generate QR:',
                  qrError);
                const invoiceMessages = await conn.sendMessage(
                  m.chat,
                  {
                    text: caption + `\n*Kode QRIS:*\n\`\`\`${depositData.qr_string}\`\`\``
                  }
                );

                // Tetap jalankan pengecekan status jika fallback QR string
                let attempts = 0;
                const maxAttempts = 36;

                const checkInterval = setInterval(async () => {
                  attempts++;

                  try {
                    const statusResponse = await axios.post('https://atlantich2h.com/deposit/status', qs.stringify({
                      api_key: apiKey,
                      id: user.depositId
                    }), {
                      headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                      }
                    });

                    if (statusResponse.data.status &&
                      (statusResponse.data.data.status === 'success' || statusResponse.data.data.status === 'processing')) {

                      clearInterval(checkInterval);

                      try {
                        const instantRes = await axios.post('https://atlantich2h.com/deposit/instant', qs.stringify({
                          api_key: apiKey,
                          id: user.depositId,
                          action: true
                        }), {
                          headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                          }
                        });

                        console.log("=== LOG RESPONSE INSTANT CONFIRMATION ===");
                        console.log(instantRes.data);
                        console.log("=========================================");
                      } catch (err) {
                        console.error("❌ Gagal konfirmasi instant:", err.message);
                      }

                      user.buynow = 'Done';
                      delete user.qrbuy;
                      delete user.depositId;

                      const beliStockFinal = db_stock_list.find(stock => stock.code === beliCode);
                      if (beliStockFinal) {
                        user.lockedAccounts.forEach(acc => {
                          const index = beliStockFinal.accounts.findIndex(a => a.user === acc.user && a.pass === acc.pass);
                          if (index !== -1) {
                            beliStockFinal.accounts.splice(index, 1);
                          }
                        });

                        beliStockFinal.stockSold = (beliStockFinal.stockSold || 0) + user.lockedAccounts.length;
                        beliStockFinal.totalStock = beliStockFinal.accounts.length;

                        saveDB(db_stock_list);
                      }

                      const akunList = user.lockedAccounts.map((acc, i) => `*${i + 1}.* ${acc.user}|${acc.pass}`).join('\n');
                      const successMessage =
                      `*✅ PEMBAYARAN BERHASIL!*\n\n` +
                      `${formatDesc}\n\n` +
                      `*┏━━━━━━━━━━━━━━━━━━━*\n` +
                      `*┊ Detail Akun Anda ┊*\n` +
                      `*┣━━━━━━━━━━━━━━━━━━━*\n` +
                      `${akunList}\n` +
                      `*┗━━━━━━━━━━━━━━━━━━━*\n\n` +
                      `Status Pembayaran: *${statusResponse.data.data.status.toUpperCase()}*\n` +
                      `Terima kasih telah berbelanja di toko kami! 🎉`;

                      await conn.sendMessage(m.chat,
                        {
                          text: successMessage
                        },
                        {
                          quoted: invoiceMessages
                        });

                      delete user.lockedAccounts;
                    }

                    if (attempts >= maxAttempts) {
                      clearInterval(checkInterval);
                      console.log("❌ Waktu cek status habis. Pembayaran tidak diterima.");
                      m.reply('⚠️ Batas waktu pembayaran habis. Silakan coba beli ulang.');
                    }

                  } catch (err) {
                    console.error(`❌ Error cek status (Attempt ${attempts}):`, err.message);
                  }

                },
                  5000);
              }

            } catch (err) {
              console.error('❌ Error proses pembelian:',
                err);

              selectedAccounts.forEach(acc => delete acc.reservedUntil);
              saveDB(db_stock_list);

              delete user.lockedAccounts;
              delete user.kode_unik;
              delete user.qrbuy;
              delete user.pay;
              delete user.depositId;

              return m.reply('Terjadi kesalahan saat memproses pembayaran. Silakan coba lagi.');
            }
            break
          case 'stock':
          case 'stok':
            const listProdukMessage = `*╭────〔 CARA MEMBELI 〕─*\n*┊・* untuk membeli ketik perintah berikut\n*┊・* ${pric}stok (untuk melihat stok tersedia)\n*┊・* ${pric}buy kode jumlahAkun\n*┊・* contoh: ${pric}buy gmail 1\n*┊・* beli berapapun fee qris random Rp1-900\n*┊・* Trusted Since 2021\n*┊・* Grub Info Restock https://chat.whatsapp.com/FcCZ0qgFfjaElwG5DacobJ\n╰┈┈┈┈┈┈┈┈*\n\n${getProductList(db_stock_list)}`;
            if (db_stock_list.length === 0) {
              m.reply("Maaf, stok belum diisi. Silakan cek kembali nanti.");
            } else {
              m.reply(listProdukMessage);
            }
            break
          case 'setpaydisini':
            if (!isCreator) return m.reply(globalSettings.mess.owner);
            if (m.isGroup) return m.reply(globalSettings.mess.private);

            if (args.length < 1) {
              return m.reply(`Format salah. Gunakan: ${pric}setpaydisini <key>`);
            }

            const apiKey = args[0];

            try {
              const ress = await checkProfileInformation( {
                key: apiKey
              });

              if (ress.success) {
                const userData = ress.data;
                const profileInfo = `*╭────〔 Sukses | User Information 〕─*\n` +
                `*┊ Full Name*: ${userData.full_name}\n` +
                `*┊ Merchant*: ${userData.merchant}\n` +
                `*┊ Telephone*: ${userData.telephone}\n` +
                `*┊ Email*: ${userData.email}\n` +
                `*┊ Balance*: Rp${userData.saldo}\n` +
                `*┊ Held Balance*: Rp${userData.saldo_tertahan}\n` +
                `*┊ Auto Withdraw*: ${userData.auto_wd}\n` +
                `*╰┈┈┈┈┈┈┈┈*`;
                globalSettings.apikey_pay = apiKey;
                saveSettings();
                m.reply(profileInfo);
              } else {
                m.reply(`Gagal mengubah key: ${ress.msg}`);
              }
            } catch (error) {
              console.error(error);
              m.reply('Terjadi kesalahan saat mengambil informasi.');
            }
            break
          case 'riwayat':
            if (!user || !user.history || user.history.length === 0) {
              return m.reply('Tidak ada riwayat transaksi.');
            }

            let historyMessage = '*╭─────〔RIWAYAT TRANSAKSI〕──*\n*┊*\n*╰─〔Riwayat transaksi ditampilkan Max 10〕─*\n\n';

            user.history.sort((a, b) => {
              let dateA = new Date(a.date + ' ' + a.time);
              let dateB = new Date(b.date + ' ' + b.time);
              return dateB - dateA;
            });

            let latestTransactions = user.history.slice(0, 10);

            latestTransactions.forEach((transaction) => {
              let formattedDescription = transaction.description ? transaction.description.replace(/\n/g, '\n*┊・* '): '';
              historyMessage += `*╭────〔 ${transaction.date} | ${transaction.time} 〕─*\n`;
              if (transaction.type === 'buy') {
                historyMessage += `*┊・ ID TRX* : ${transaction.transactionID}\n`;
                historyMessage += `*┊・ Service* : ${transaction.service}\n`;
                historyMessage += `*┊・ Kode Produk* : ${transaction.productCode}\n`;
                historyMessage += `*┊・ Deskripsi* : ${formattedDescription}\n`;
                historyMessage += `*┊・ Status* : ${transaction.status}\n`;
                historyMessage += `*┊・ Harga* : Rp${transaction.price.toLocaleString('id-ID')}\n`;
                historyMessage += `*┊・ Jumlah Dibeli* : ${transaction.amountBought}\n`;
                historyMessage += `*┊・ Total Dibayar* : Rp${transaction.totalPrice.toLocaleString('id-ID')}\n`;
                historyMessage += `*┊・ Saldo Awal* : Rp${transaction.initialBalance.toLocaleString('id-ID')}\n`;
              } else if (transaction.type === 'depo') {
                historyMessage += `*┊・ ID* : ${transaction.id}\n`;
                historyMessage += `*┊・ ID Akun* : ${transaction.akunid}\n`;
                historyMessage += `*┊・ WhatsApp* : ${transaction.nowa}\n`;
                historyMessage += `*┊・ Service* : ${transaction.service}\n`;
                historyMessage += `*┊・ Deskripsi* : ${transaction.desk}\n`;
                historyMessage += `*┊・ Status* : ${transaction.status}\n`;
                historyMessage += `*┊・ Saldo Masuk* : Rp${transaction.saldomasuk.toLocaleString('id-ID')}\n`;
                historyMessage += `*┊・ Total Saldo* : Rp${transaction.totalsaldo.toLocaleString('id-ID')}\n`;
                historyMessage += `*┊・ Saldo Awal* : Rp${transaction.saldoawal.toLocaleString('id-ID')}\n`;
              }
              historyMessage += `*┊・ Tanggal Transaksi* : ${transaction.date}\n`;
              historyMessage += `*┊・ Jam Transaksi* : ${transaction.time}\n`;
              historyMessage += `*╰┈┈┈┈┈┈┈┈*\n`;
            });

            m.reply(historyMessage);
            break
        }
      } else if (body) {
        if (!m.isGroup) {
          if (user.firstuse === true) {
            if (m.sender === botNumber) {
              return;
            }
            const listProdukMessage = `*╭────〔 CARA MEMBELI 〕─*\n*┊・* untuk membeli ketik perintah berikut\n*┊・* ${pric}stok (untuk melihat stok tersedia)\n*┊・* ${pric}buy kode jumlahAkun\n*┊・* contoh: ${pric}buy gmail 1\n*┊・* beli berapapun fee qris random Rp1-900\n*┊・* Trusted Since 2021\n*┊・* Grub Info Restock https://chat.whatsapp.com/FcCZ0qgFfjaElwG5DacobJ\n╰┈┈┈┈┈┈┈┈*\n\n${getProductList(db_stock_list)}`;
            if (db_stock_list.length === 0) {
              m.reply("Maaf, stok belum diisi. Silakan cek kembali nanti.");
            } else {
              m.reply(listProdukMessage);
            }
            user.firstuse = false;
          }
        }
      } else if (body.trim().startsWith("FORMAT YOUTUBE")) {
        if (m.isGroup) return m.reply(globalSettings.mess.private);
        if (user.session === 'claimgaransi') {
          const formatclaim = args.join(' ');
          conn.sendMessage(m.chat, {
            text: `📢  REPORT SENT ::\n\nstatus :: report berhasil dikirim.\n\nsilakan tunggu 2x24 jam, fixing akan\ndikirim melalui bot ini jadi make\nsure sebelum resend form, cek\ndulu bot ini. terimakasih.`
          });
          globalSettings.owner.forEach(function(number) {
            conn.sendMessage(number + '@s.whatsapp.net', {
              'text': `*Request Claim Garansi*\n*WA:* wa.me/${m.sender.split("@")[0]}\n\nCLAIM GARANSI ${formatclaim}`
            });
          });
          user.session = '';
        }
      }

      for (let name in global.features) {
        let plugin = global.features[name]
        if (!plugin) continue
        if (plugin.disabled) continue
        if (typeof plugin.all === 'function') {
          try {
            await plugin.all.call(this, m, chatUpdate)
          } catch (e) {
            console.error(e)
          }
        }
        const str2Regex = str => str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
        let _prefix = plugin.customPrefix ? plugin.customPrefix: conn.prefix ? conn.prefix: global.prefix
        let match = (_prefix instanceof RegExp ?
          [[_prefix.exec(m.text), _prefix]]:
          Array.isArray(_prefix) ?
          _prefix.map(p => {
            let re = p instanceof RegExp ?
            p:
            new RegExp(str2Regex(p))
            return [re.exec(m.text), re]
          }):
          typeof _prefix === 'string' ?
          [[new RegExp(str2Regex(_prefix)).exec(m.text), new RegExp(str2Regex(_prefix))]]:
          [[[], new RegExp]]
        ).find(p => p[1])
        if (typeof plugin.before === 'function') if (await plugin.before.call(this, m, {
          match,
          conn: this,
          participants,
          groupMetadata,
          user,
          bot,
          isROwner,
          isOwner,
          isRAdmin,
          isAdmin,
          isBotAdmin,
          isBans,
          chatUpdate,
        })) continue
        if (typeof plugin !== 'function') continue
        if ((usedPrefix = (match[0] || '')[0])) {
          let noPrefix = m.text.replace(usedPrefix, '')
          let [command,
            ...args] = noPrefix.trim().split` `.filter(v => v)
          args = args || []
          let _args = noPrefix.trim().split` `.slice(1)
          let text = _args.join` `
          command = (command || '').toLowerCase()
          let fail = plugin.fail || global.dfail
          let isAccept = plugin.command instanceof RegExp ?
          plugin.command.test(command):
          Array.isArray(plugin.command) ?
          plugin.command.some(cmd => cmd instanceof RegExp ?
            cmd.test(command):
            cmd === command
          ):
          typeof plugin.command === 'string' ?
          plugin.command === command:
          false

          if (!isAccept) continue
          m.plugin = name
          if (m.chat in global.db.data.chats || m.sender in global.db.data.users) {
            let chat = global.db.data.chats[m.chat]
            let user = global.db.data.users[m.sender]
            if (name != 'unbanchat.js' && chat && chat.isBanned && !isOwner) return
          }
          if (plugin.rowner && plugin.owner && !(isROwner || isOwner)) {
            fail('owner', m, this)
            continue
          }
          if (plugin.rowner && !isROwner) {
            fail('rowner', m, this)
            continue
          }
          if (plugin.restrict) {
            fail('restrict', m, this)
            continue
          }
          if (plugin.owner && !isOwner) {
            fail('owner', m, this)
            continue
          }
          if (plugin.mods && !isMods) {
            fail('mods', m, this)
            continue
          }
          if (plugin.banned && !isBans) {
            fail('banned', m, this)
            continue
          }
          if (plugin.group && !m.isGroup) {
            fail('group', m, this)
            continue
          } else if (plugin.botAdmin && !isBotAdmin) {
            fail('botAdmin', m, this)
            continue
          } else if (plugin.admin && !isAdmin) {
            fail('admin', m, this)
            continue
          }
          if (plugin.private && m.isGroup) {
            fail('private', m, this)
            continue
          }
          if (plugin.register == true && _user.registered == false) {
            fail('unreg', m, this)
            continue
          }
          m.isCommand = true
          let extra = {
            match,
            usedPrefix,
            noPrefix,
            _args,
            args,
            command,
            text,
            conn: this,
            participants,
            groupMetadata,
            user,
            bot,
            isROwner,
            isOwner,
            isRAdmin,
            isAdmin,
            isBotAdmin,
            isBans,
            chatUpdate,
          }
          try {
            await plugin.call(this, m, extra)
          } catch (e) {
            m.error = e
            console.error(e)
            if (e) {
              let text = util.format(e)

              if (e.name) for (let [jid] of globalSettings.owner.filter(([numbe]) => number)) {
                let data = (await conn.onWhatsApp(jid))[0] || {}
                if (data.exists) m.reply(`━━━━━ *「 ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ 」*━━━━━━━
                  •> *ᴘʟᴜɢɪɴ:*  ${m.plugin}
                  •> *ꜱᴇɴᴅᴇʀ:* @${m.sender.split("@")[0]} *(wa.me/${m.sender.split("@")[0]})*
                  •> *ᴄʜᴀᴛ:* ${m.chat}
                  •> *ᴄᴏᴍᴍᴀɴᴅ:* ${usedPrefix + command}

                  *[!] ᴇʀʀᴏʀ ʟᴏɢ:*

                  ${text}

                  ━━━━━ *「 ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ 」*━━━━━━━`.trim(), data.jid)
              }
              m.reply(text)
            }
          } finally {
            if (typeof plugin.after === 'function') {
              try {
                await plugin.after.call(this, m, extra)
              } catch (e) {
                console.error(e)
              }
            }
          }
          break
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      if (opts['queque'] && m.text) {
        const quequeIndex = this.msgqueque.indexOf(m.id || m.key.id)
        if (quequeIndex !== -1) this.msgqueque.splice(quequeIndex, 1)
      }
      let user,
      stats = global.db.data.stats
      if (m) {
        let stat
        if (m.plugin) {
          let now = + new Date
          if (m.plugin in stats) {
            stat = stats[m.plugin]
            if (!isNumber(stat.total)) stat.total = 1
            if (!isNumber(stat.success)) stat.success = m.error != null ? 0: 1
            if (!isNumber(stat.last)) stat.last = now
            if (!isNumber(stat.lastSuccess)) stat.lastSuccess = m.error != null ? 0: now
          } else stat = stats[m.plugin] = {
            total: 1,
            success: m.error != null ? 0: 1,
            last: now,
            lastSuccess: m.error != null ? 0: now
          }
          stat.total += 1
          stat.last = now
          if (m.error == null) {
            stat.success += 1
            stat.lastSuccess = now
          }
        }
      }
      if (opts['autoread']) await this.chatRead(m.chat, m.isGroup ? m.sender: undefined, m.id || m.key.id).catch(() => {})
    }
  },
  async delete(m) {
    let chat = global.db.data
    if (chat.delete) return this.reply(m.chat, `
      Terdeteksi @${m.sender.split`@`[0]} telah menghapus pesan
      ketik *.disable delete* untuk mematikan pesan ini
      `.trim(), m)
    this.copyNForward(m.quoted, m.chat)
    .catch(e => {
      console.log(e, m)
    })
  },
  async GroupUpdate( {
    jid, desc, descId, descTime, descOwner, announce, m
  }) {
    if (!db.data.chats[jid].desc) return
    if (!desc) return
    let caption = `
    @${descOwner.split`@`[0]} telah mengubah deskripsi grup.
    ${desc}
    `.trim()
    this.sendMessage(jid, caption, {
      quoted: m
    })
  }
},

global.dfail = (type, m, conn) => {
  let fkontak = {
    "key": {
      "participants": "0@s.whatsapp.net",
      "remoteJid": "status@broadcast",
      "fromMe": false,
      "id": "Halo"
    },
    "message": {
      "contactMessage": {
        "vcard": `BEGIN:VCARD\nVERSION:3.0\nN:Sy;Bot;;;\nFN:y\nitem1.TEL;waid=${m.sender.split('@')[0]}:${m.sender.split('@')[0]}\nitem1.X-ABLabel:Ponsel\nEND:VCARD`
      }
    },
    "participant": "0@s.whatsapp.net"
  };
}

let chalk = require('chalk')
let file = require.resolve(__filename)
fs.watchFile(file, () => {
  fs.unwatchFile(file)
  console.log(chalk.redBright("Update 'handler.js'"))
  delete require.cache[file]
  if (global.reloadHandler) console.log(global.reloadHandler())
})
