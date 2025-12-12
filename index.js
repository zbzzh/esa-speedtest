/**
 * 阿里云 ESA 专业并发测速 (HTTP Concurrent Chunking)
 * 核心逻辑：前端多线程并发请求，后端只返回固定小块，彻底解决超时和熔断问题。
 */

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request);
    } catch (e) {
      return new Response(e.message, { status: 500 });
    }
  }
};

// 后端：定义一个共享的内存块 (16MB)
// 为什么是 16MB？
// 1. 足够大，能减少 HTTP 握手开销
// 2. 足够小，6 个并发只占用 24MB 内存，远低于 128MB 限制，绝对安全
const CHUNK_SIZE = 16 * 1024 * 1024; 
const SHARED_BUFFER = new Uint8Array(CHUNK_SIZE).fill(88); // 填充 'X'

async function handleRequest(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode'); 

  // 设置通用的 CORS 头，允许跨域
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate', // 禁止浏览器缓存
    'Pragma': 'no-cache',
  };

  // 1. 模式：Ping
  if (mode === 'ping') {
    return new Response('pong', { headers });
  }

  // 2. 模式：下载 (Down)
  // 此时后端非常轻松，只需要把准备好的 buffer 扔出去就行，不做任何流式计算
  if (mode === 'down') {
    return new Response(SHARED_BUFFER, { 
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream'
      }
    });
  }

  // 3. 模式：上传 (Up)
  // 接收数据并丢弃
  if (mode === 'up' && request.method === 'POST') {
    const reader = request.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
    }
    return new Response(JSON.stringify({ received }), { headers });
  }

  // 4. 返回前端页面
  return new Response(htmlContent(), {
    headers: { 'content-type': 'text/html;charset=UTF-8' },
  });
}

function htmlContent() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>阿里云 ESA 并发测速</title>
    <style>
        body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f0f2f5; text-align: center; color: #333; }
        .container { background: white; padding: 30px; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
        h1 { font-size: 1.5rem; margin-bottom: 25px; }
        .dashboard { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 30px; }
        .stat-card { background: #f8f9fa; padding: 15px; border-radius: 10px; border: 1px solid #e9ecef; }
        .stat-label { font-size: 0.85rem; color: #666; margin-bottom: 5px; display: block; }
        .stat-value { font-size: 1.6rem; font-weight: 700; color: #0070f3; }
        .stat-unit { font-size: 0.8rem; color: #999; font-weight: normal; }
        
        button { background: #0070f3; color: white; border: none; padding: 14px 40px; font-size: 1rem; border-radius: 50px; cursor: pointer; font-weight: 600; box-shadow: 0 4px 10px rgba(0,112,243,0.3); transition: transform 0.1s; }
        button:active { transform: scale(0.98); }
        button:disabled { background: #a0a0a0; box-shadow: none; cursor: not-allowed; }
        
        .status-bar { margin-top: 20px; height: 6px; background: #e0e0e0; border-radius: 3px; overflow: hidden; }
        .status-fill { height: 100%; background: #0070f3; width: 0%; transition: width 0.3s linear; }
        #log { margin-top: 20px; font-size: 12px; color: #888; text-align: left; height: 100px; overflow-y: auto; font-family: monospace; }
        .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #e1f5fe; color: #0288d1; font-size: 12px; margin-bottom: 15px;}
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 ESA 边缘并发测速</h1>
        <div class="tag">HTTP并发 x 6线程</div>
        
        <div class="dashboard">
            <div class="stat-card">
                <span class="stat-label">延迟 Ping</span>
                <span id="val-ping" class="stat-value">--</span>
                <span class="stat-unit">ms</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">下载 Download</span>
                <span id="val-down" class="stat-value">--</span>
                <span class="stat-unit">Mbps</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">上传 Upload</span>
                <span id="val-up" class="stat-value">--</span>
                <span class="stat-unit">Mbps</span>
            </div>
        </div>

        <button id="btn-start" onclick="runSpeedTest()">开始测速</button>
        
        <div class="status-bar"><div id="progress" class="status-fill"></div></div>
        <div id="log"></div>
    </div>

    <script>
        // 配置参数
        const THREADS = 6;           // 并发线程数 (推荐 4-6)
        const TEST_TIME = 10000;     // 测试时长 (10秒)
        const DOWNLOAD_CHUNK_SIZE = 4 * 1024 * 1024; // 必须匹配后端 (4MB)
        
        const logEl = document.getElementById('log');
        function log(msg) { logEl.innerHTML = \`<div>[\${new Date().toLocaleTimeString()}] \${msg}</div>\` + logEl.innerHTML; }
        function updateVal(id, val) { document.getElementById('val-'+id).innerText = val; }

        async function runSpeedTest() {
            const btn = document.getElementById('btn-start');
            btn.disabled = true;
            updateVal('ping', '--'); updateVal('down', '--'); updateVal('up', '--');
            document.getElementById('progress').style.width = '0%';

            try {
                // ==========================================
                // 1. Ping 测试
                // ==========================================
                log('正在测试延迟 (Ping)...');
                const tStart = performance.now();
                await fetch('?mode=ping&t=' + Date.now());
                const ping = (performance.now() - tStart).toFixed(0);
                updateVal('ping', ping);
                document.getElementById('progress').style.width = '10%';

                // ==========================================
                // 2. 多线程下载测速
                // ==========================================
                log(\`正在测试下载 (\${THREADS}线程并发)...\`);
                const downStart = performance.now();
                let downBytes = 0;
                let isDownRunning = true;

                // 定义单个工人的工作内容
                const downloadWorker = async () => {
                    while (isDownRunning) {
                        try {
                            const res = await fetch('?mode=down&t=' + Date.now() + Math.random());
                            // 读取整个blob (后端是固定大小，直接blob()最快)
                            const blob = await res.blob();
                            downBytes += blob.size;
                        } catch (e) {
                            // 忽略中止错误
                        }
                    }
                };

                // 启动 N 个并发线程
                const downPromises = [];
                for (let i = 0; i < THREADS; i++) {
                    downPromises.push(downloadWorker());
                }

                // 定时器：更新 UI 和 结束测试
                await new Promise(resolve => {
                    const timer = setInterval(() => {
                        const now = performance.now();
                        const duration = (now - downStart) / 1000;
                        const speed = ((downBytes * 8) / (1024 * 1024) / duration).toFixed(2);
                        updateVal('down', speed);
                        
                        // 进度条动画 (10% -> 55%)
                        const progress = 10 + (duration / (TEST_TIME/1000)) * 45;
                        document.getElementById('progress').style.width = Math.min(progress, 55) + '%';

                        if (duration >= TEST_TIME / 1000) {
                            isDownRunning = false; // 停止所有线程
                            clearInterval(timer);
                            resolve();
                        }
                    }, 200);
                });

                log('下载测试完成');
                document.getElementById('progress').style.width = '55%';


                // ==========================================
                // 3. 多线程上传测速
                // ==========================================
                log(\`正在测试上传 (\${THREADS}线程并发)...\`);
                const upStart = performance.now();
                let upBytes = 0;
                let isUpRunning = true;
                // 准备 1MB 数据用于上传
                const upChunk = new Uint8Array(1024 * 1024).fill(1); 

                const uploadWorker = async () => {
                    while (isUpRunning) {
                        try {
                            await fetch('?mode=up', { 
                                method: 'POST', 
                                body: upChunk 
                            });
                            upBytes += upChunk.length;
                        } catch (e) {}
                    }
                };

                // 启动上传线程
                const upPromises = [];
                for (let i = 0; i < THREADS; i++) {
                    upPromises.push(uploadWorker());
                }

                await new Promise(resolve => {
                    const timer = setInterval(() => {
                        const now = performance.now();
                        const duration = (now - upStart) / 1000;
                        const speed = ((upBytes * 8) / (1024 * 1024) / duration).toFixed(2);
                        updateVal('up', speed);

                        // 进度条 (55% -> 100%)
                        const progress = 55 + (duration / (TEST_TIME/1000)) * 45;
                        document.getElementById('progress').style.width = Math.min(progress, 100) + '%';

                        if (duration >= TEST_TIME / 1000) {
                            isUpRunning = false;
                            clearInterval(timer);
                            resolve();
                        }
                    }, 200);
                });

                log('全部完成!');

            } catch (e) {
                log('❌ 出错: ' + e.message);
                console.error(e);
            }
            btn.disabled = false;
            btn.innerText = '再次测速';
        }
    </script>
</body>
</html>
  `;
}
