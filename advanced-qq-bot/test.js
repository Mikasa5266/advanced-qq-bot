const { execSync } = require('child_process');
const axios = require('axios');

async function runTest() {
    console.log("🚀 启动物理穿透测试...");
    try {
        // 自动获取 NapCat 容器的真实内网 IP
        const ip = execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' napcat`).toString().trim();
        console.log(`🎯 成功锁定 NapCat 容器内部 IP: ${ip}`);
        
        // 绕过 127.0.0.1，直接向容器 IP 开炮
        const response = await axios.post(`http://${ip}:3000/send_private_msg`, {
            user_id: 1140893485, // 你的大号QQ
            message: "这是一条来自容器内部物理穿透的测试消息！"
        });
        console.log("✅ 完美通关！NapCat 接收成功，返回数据：", response.data);
    } catch (error) {
        console.error("❌ 依然失败！错误原因：", error.message);
    }
}

runTest();
