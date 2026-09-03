// pm2 啟動設定：正式站以此檔為準，避免忘了帶時區等環境變數。
//   pm2 start ecosystem.config.js        首次啟動
//   pm2 restart knitpsychotherapies --update-env 套用此檔的環境變數
module.exports = {
  apps: [{
    name: 'knitpsychotherapies',
    script: 'src/server.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
      PORT: 3440,
      // 主機時區是 UTC；不設這個，資料庫寫入的時間會少 8 小時
      TZ: 'Asia/Taipei',
      // 異地備份要用本所專屬目錄：預設的 /root/backups/mindcare 與同一台主機上
      // 另一套 mindcare 同名，兩邊的備份檔名一樣會互相覆蓋。
      MINDCARE_BACKUP_MIRROR: '/root/backups/knitpsychotherapies'
    },
    max_restarts: 10,
    time: true
  }]
};
