module.exports = {
  apps: [
    {
      name: 'hft-trading-lifestyle-quant',
      script: './node_modules/.bin/tsx',
      args: 'server/index.ts',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 3000,
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      max_memory_restart: '1G',
    },
  ],
};
