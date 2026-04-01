module.exports = {
    apps: [
        {
            name: 'advanced-qq-bot',
            script: 'index.js',
            cwd: __dirname,
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '300M',
            time: true,
            merge_logs: true,
            out_file: './logs/out.log',
            error_file: './logs/error.log',
            env_file: '.env',
            env: {
                NODE_ENV: 'development'
            },
            env_production: {
                NODE_ENV: 'production',
                ONEBOT_ACCESS_TOKEN: "T~V6dnPn7HJo-JdI"
            }
        }
    ]
};
