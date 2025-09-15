const fs = require('fs');

let globalSettings = {
  apikey_pay: '15xyWfE4x76sm4Q1yIfadFg7wvQwlyNna8sL8nM77UuUNXJsDpK283ISQqEMRb1C5ArKyoQ16qSXz4LgeJC8iTnhU1kRY3wcIjiy',
  nomorbot: '6285173317723',
  owner: ['6285173329868', '62895700259709', '6282253841878', '6285730882379'],
  isPairing: true,
  caption_pay: "▰ PEMBAYARAN : \n▰ E-Wallet\n➡️ DANA : 082250557228\n➡️ GOPAY : 082250557228\n➡️ OVO: 082250557228\n\n▰ Via Bank\n➡️ BCA : 6965106859\n\n▰ NOTE :\n🚨 TOP UP (DANA/GOPAY) DARI BANK + Rp. 1.000\n",
  mess: {
      rowner: `*• Owner Mode:* This feature is only for owners`,
      owner: `*• Owner Mode:* This feature is only for owners`,
      mods: `*• Moderator Mode:* This feature is for moderators only`,
      group: `*• Group Mode:* This feature is only for groups`,
      banned: `*• Banned Mode:* This feature is only for Banned user`,
      private: `*• Private Chat Mode:* This feature is only for private chat`,
      admin: `*• Admin Mode:* This feature is only for admin`,
      botAdmin: `*• Bot Admin Mode:* Bot must be an admin to use this feature`,
      restrict: `*• Restricted Mode:* This feature has disabled`,
      notRegistered: `Silahkan ketik \`daftar\` Untuk Melanjutkan`
  }
};

function saveSettings() {
  fs.writeFileSync('./global_settings.json', JSON.stringify(globalSettings, null, 4));
};

if (!fs.existsSync('./global_settings.json')) {
  saveSettings();
} else {
  try {
      const savedSettings = require('./global_settings.json');
      Object.assign(globalSettings, savedSettings);
  } catch (error) {
      console.log("Failed to load settings:", error);
  }
}

module.exports = {
  globalSettings,
  saveSettings
};
