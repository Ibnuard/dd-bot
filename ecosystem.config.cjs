// Run with PM2:
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name: 'doomsday-bot',
      cwd: __dirname,
      script: 'index.js',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '256M',
    },
  ],
};
