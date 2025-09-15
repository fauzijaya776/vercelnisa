const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

function ConvertCRC16(str) {
  let crc = 0xFFFF;
  for (let c = 0; c < str.length; c++) {
    crc ^= str.charCodeAt(c) << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
    }
  }
  let hex = crc & 0xFFFF;
  hex = hex.toString(16).toUpperCase();
  if (hex.length === 3) hex = '0' + hex;
  return hex;
}

function pad(num) {
  if (isNaN(num) || num === null || num === undefined) {
    throw new Error('Nominal tidak valid, harus berupa angka.');
  }

  return num < 10 ? '0' + num: num.toString();
}

async function generateQRCode(qr, nominal) {
  if (!nominal || isNaN(nominal)) {
    throw new Error('Nominal harus berupa angka yang valid');
  }

  qr = qr.slice(0, -4);
  let step1 = qr.replace('010211', '010212');
  let step2 = step1.split('5802ID'); 
  let uang = '54' + pad(nominal.toString().length) + nominal.toString();
  uang += '5802ID';

  let fix = step2[0].trim() + uang + step2[1].trim();
  fix += ConvertCRC16(fix);

  const tmpDir = './tmp';
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir);
  }

  const filename = `qrcode_${Date.now()}.png`;

  try {
    await QRCode.toFile(path.join(tmpDir, filename), fix, {
      margin: 2,
      scale: 10
    });

    console.log(`QR Code berhasil dibuat dan disimpan di tmp/${filename}`);

    return path.join(tmpDir, filename);
  } catch (error) {
    console.error('Terjadi kesalahan dalam membuat QR Code:', error);
    throw error;
  }
}


module.exports = generateQRCode;