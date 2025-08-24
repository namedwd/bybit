const WebSocket = require('ws');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Supabase 클라이언트 초기화
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// HTTP 서버 생성 - POST 요청 처리 추가
const server = http.createServer(async (req, res) => {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // OPTIONS 요청 처리 (CORS preflight)
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // 새 주문 알림 처리
    if (req.method === 'POST' && req.url === '/new-order') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                console.log('\n📮 새 주문 알림 받음:', {
                    orderId: data.orderId,
                    symbol: data.symbol,
                    side: data.side,
                    price: data.price
                });
                
                // 즉시 주문 로드
                await loadPendingOrders();
                
                // 현재 가격과 즉시 비교
                const currentPrice = lastPrices.get(data.symbol);
                if (currentPrice) {
                    console.log(`💹 현재 ${data.symbol} 가격: ${currentPrice.toFixed(2)}`);
                    await checkPendingOrders(data.symbol, currentPrice);
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: '주문 알림 처리 완료' }));
            } catch (error) {
                console.error('주문 알림 처리 오류:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
        return;
    }
    
    // 주문 취소 알림 처리
    if (req.method === 'POST' && req.url === '/cancel-order') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                console.log('🚫 주문 취소 알림:', data.orderId);
                
                // 메모리에서 즉시 제거
                pendingOrders.delete(data.orderId);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
        return;
    }
    
    // 상태 확인 엔드포인트
    if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'running',
            pendingOrders: pendingOrders.size,
            activePositions: activePositions.size,
            prices: Object.fromEntries(lastPrices),
            timestamp: new Date().toISOString()
        }));
        return;
    }
    
    // 기본 응답
    res.writeHead(404);
    res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

// Bybit WebSocket 연결
let bybitWS = null;
let reconnectInterval = 5000;
let shouldReconnect = true;

// 연결된 클라이언트들
const clients = new Set();

// 메모리에 저장할 활성 주문/포지션
let activePositions = new Map();
let pendingOrders = new Map();
let lastPrices = new Map();

// 로그 제한 (가격 로그 줄이기)
let priceLogCounter = 0;
const PRICE_LOG_INTERVAL = 1000; // 1000번에 1번만 로그

// Bybit WebSocket 연결 함수
function connectBybit() {
    bybitWS = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    
    bybitWS.on('open', async () => {
        console.log('✅ Bybit WebSocket 연결됨');
        
        const subscribeMsg = {
            op: "subscribe",
            args: [
                // BTC
                "publicTrade.BTCUSDT",
                "orderbook.50.BTCUSDT",
                "tickers.BTCUSDT",
                "kline.1.BTCUSDT",
                // ETH
                "publicTrade.ETHUSDT",
                "orderbook.50.ETHUSDT",
                "tickers.ETHUSDT",
                "kline.1.ETHUSDT",
                // SOL
                "publicTrade.SOLUSDT",
                "orderbook.50.SOLUSDT",
                "tickers.SOLUSDT",
            ]
        };
        
        bybitWS.send(JSON.stringify(subscribeMsg));
        console.log('📡 구독 요청 전송됨');
        
        // 초기 데이터 로드
        await loadActivePositions();
        await loadPendingOrders();
        
        // Ping 메시지 (연결 유지)
        setInterval(() => {
            if (bybitWS.readyState === WebSocket.OPEN) {
                bybitWS.send(JSON.stringify({ op: "ping" }));
            }
        }, 20000);
    });
    
    bybitWS.on('message', async (data) => {
        const message = data.toString();
        const parsedData = JSON.parse(message);
        
        if (parsedData.op === 'pong') return;
        
        // 실시간 체결가 처리
        if (parsedData.topic && parsedData.topic.includes('publicTrade')) {
            await handlePriceUpdate(parsedData);
        }
        
        // 클라이언트에게 브로드캐스트
        broadcastToClients(message);
    });
    
    bybitWS.on('error', (error) => {
        console.error('❌ Bybit WebSocket 에러:', error);
    });
    
    bybitWS.on('close', () => {
        console.log('🔌 Bybit WebSocket 연결 종료');
        
        if (shouldReconnect) {
            setTimeout(() => {
                console.log('🔄 Bybit 재연결 시도...');
                connectBybit();
            }, reconnectInterval);
        }
    });
}

// 가격 업데이트 처리
async function handlePriceUpdate(data) {
    if (!data.data || data.data.length === 0) return;
    
    const trade = data.data[0];
    const symbol = data.topic.split('.')[1];
    const price = parseFloat(trade.p);
    
    // 현재 가격 저장
    lastPrices.set(symbol, price);
    
    // 가격 로그 제한 (1000번에 1번)
    if (++priceLogCounter % PRICE_LOG_INTERVAL === 0) {
        console.log(`💹 ${symbol}: $${price.toFixed(2)} | 대기주문: ${pendingOrders.size}개`);
    }
    
    // 포지션 체크
    await checkPositions(symbol, price);
    
    // 대기 주문 체크
    await checkPendingOrders(symbol, price);
}

// 포지션 체크 (익절/손절/청산)
async function checkPositions(symbol, currentPrice) {
    const positionsToCheck = [];
    
    for (const [positionId, position] of activePositions) {
        if (position.symbol === symbol && position.status === 'open') {
            positionsToCheck.push({ id: positionId, ...position });
        }
    }
    
    for (const position of positionsToCheck) {
        // DB에서 현재 상태 재확인
        const { data: currentPosition, error } = await supabase
            .from('trading_positions')
            .select('status')
            .eq('id', position.id)
            .single();
        
        if (error || !currentPosition || currentPosition.status !== 'open') {
            activePositions.delete(position.id);
            continue;
        }
        
        let shouldClose = false;
        let closeReason = '';
        
        // 익절/손절 체크
        if (position.side === 'long') {
            if (position.tp_price && currentPrice >= position.tp_price) {
                shouldClose = true;
                closeReason = 'tp';
            } else if (position.sl_price && currentPrice <= position.sl_price) {
                shouldClose = true;
                closeReason = 'sl';
            }
        } else if (position.side === 'short') {
            if (position.tp_price && currentPrice <= position.tp_price) {
                shouldClose = true;
                closeReason = 'tp';
            } else if (position.sl_price && currentPrice >= position.sl_price) {
                shouldClose = true;
                closeReason = 'sl';
            }
        }
        
        const pnl = calculatePnL(position, currentPrice);
        const pnlPercentage = (pnl / position.margin) * 100;
        
        // 청산 체크
        if (pnlPercentage <= -80) {
            shouldClose = true;
            closeReason = 'liquidation';
        }
        
        if (shouldClose) {
            await closePosition(position.id, currentPrice, closeReason, pnl);
        } else {
            await updatePositionPnL(position.id, currentPrice, pnl, pnlPercentage);
        }
    }
}

// 대기 주문 체크
async function checkPendingOrders(symbol, currentPrice) {
    for (const [orderId, order] of pendingOrders) {
        if (order.symbol !== symbol || order.status !== 'pending') {
            continue;
        }
        
        let shouldFill = false;
        const orderPrice = parseFloat(order.price);
        
        if (order.type === 'limit') {
            const isBuyOrder = order.side === 'buy' || order.order_side === 'buy';
            const isSellOrder = order.side === 'sell' || order.order_side === 'sell';
            
            if (isBuyOrder && currentPrice <= orderPrice) {
                shouldFill = true;
                console.log(`\n🎯 Buy Limit 체결 조건 충족!`);
                console.log(`  심볼: ${symbol}`);
                console.log(`  현재가: $${currentPrice.toFixed(2)} <= 주문가: $${orderPrice.toFixed(2)}\n`);
            } else if (isSellOrder && currentPrice >= orderPrice) {
                shouldFill = true;
                console.log(`\n🎯 Sell Limit 체결 조건 충족!`);
                console.log(`  심볼: ${symbol}`);
                console.log(`  현재가: $${currentPrice.toFixed(2)} >= 주문가: $${orderPrice.toFixed(2)}\n`);
            }
        }
        
        if (shouldFill) {
            await fillOrder(orderId, currentPrice);
        }
    }
}

// PnL 계산
function calculatePnL(position, currentPrice) {
    if (position.side === 'long') {
        return (currentPrice - position.entry_price) * position.size;
    } else {
        return (position.entry_price - currentPrice) * position.size;
    }
}

// 포지션 종료 (DB 함수 사용)
async function closePosition(positionId, price, reason, pnl) {
try {
const position = activePositions.get(positionId);
if (!position) return;

// 중복 처리 방지 체크
const { data: currentStatus, error: statusError } = await supabase
.from('trading_positions')
.select('status')
.eq('id', positionId)
  .single();

if (statusError || !currentStatus || currentStatus.status !== 'open') {
activePositions.delete(positionId);
  return;
}

// 🔥 DB 함수를 사용하여 원자적으로 처리
const { data: result, error } = await supabase.rpc('close_position_with_balance', {
p_position_id: positionId,
p_close_price: price,
p_pnl: pnl,
p_close_reason: reason
});

if (error) {
console.error('포지션 종료 DB 함수 에러:', error);
  throw error;
}

if (result && result.success) {
  activePositions.delete(positionId);
  
console.log(`📊 포지션 종료: ${position.symbol} ${reason.toUpperCase()} at $${price.toFixed(2)}, PnL: $${pnl.toFixed(2)}`);
console.log(`   잔고 변경: $${result.old_balance} → $${result.new_balance} (+$${result.return_amount})`);

broadcastToClients(JSON.stringify({
type: 'position_closed',
  data: { 
    positionId, 
  reason, 
  price, 
  pnl,
newBalance: result.new_balance
}
}));
} else {
  console.error('포지션 종료 실패:', result?.error || '알 수 없는 오류');
  activePositions.delete(positionId);
}

} catch (error) {
console.error('포지션 종료 에러:', error);
}
}

// 포지션 PnL 업데이트
async function updatePositionPnL(positionId, currentPrice, pnl, pnlPercentage) {
    try {
        await supabase
            .from('trading_positions')
            .update({
                mark_price: currentPrice,
                pnl: pnl,
                pnl_percentage: pnlPercentage
            })
            .eq('id', positionId);
            
        const position = activePositions.get(positionId);
        if (position) {
            position.mark_price = currentPrice;
            position.pnl = pnl;
            position.pnl_percentage = pnlPercentage;
        }
    } catch (error) {
        console.error('PnL 업데이트 에러:', error);
    }
}

// 주문 체결
async function fillOrder(orderId, price) {
    try {
        const order = pendingOrders.get(orderId);
        if (!order) return;
        
        // 🔥 중복 체결 방지 - 메모리에서 즉시 제거
        pendingOrders.delete(orderId);
        
        // DB 상태 확인 (이미 체결되었는지)
        const { data: currentOrder, error: checkError } = await supabase
            .from('trading_orders')
            .select('status')
            .eq('id', orderId)
            .single();
        
        if (checkError || !currentOrder || currentOrder.status !== 'pending') {
            console.log(`⚠️ 주문 ${orderId.substring(0, 8)} 이미 처리됨`);
            return;
        }
        
        console.log(`📝 주문 체결 처리:`, {
            orderId: orderId.substring(0, 8),
            symbol: order.symbol,
            side: order.order_side,
            size: order.size,
            orderPrice: order.price,
            fillPrice: price
        });
        
        // status를 먼저 업데이트 (중복 방지)
        const { error: updateError } = await supabase
            .from('trading_orders')
            .update({
                status: 'filled',
                filled_price: price,
                filled_at: new Date().toISOString()
            })
            .eq('id', orderId)
            .eq('status', 'pending'); // pending 상태일 때만 업데이트
        
        if (updateError) {
            console.error('주문 업데이트 에러:', updateError);
            return;
        }
        
        const margin = (order.size * price) / order.leverage;
        
        // 🔥 중요: 지정가 주문 체결 시 증거금 차감
        const { data: userData, error: userError } = await supabase
            .from('trading_users')
            .select('balance')
            .eq('id', order.user_id)
            .single();
        
        if (!userError && userData) {
            const newBalance = parseFloat(userData.balance) - margin;
            await supabase
                .from('trading_users')
                .update({ balance: newBalance })
                .eq('id', order.user_id);
            console.log(`   잘고 변경: ${userData.balance} → ${newBalance.toFixed(2)} (-${margin.toFixed(2)})`);
        }
        
        const { data: newPosition, error } = await supabase
            .from('trading_positions')
            .insert({
                user_id: order.user_id,
                symbol: order.symbol,
                side: order.order_side === 'buy' ? 'long' : 'short',
                size: order.size,
                entry_price: price,
                leverage: order.leverage,
                margin: margin,
                tp_price: order.tp_price,
                sl_price: order.sl_price,
                status: 'open'
            })
            .select()
            .single();
        
        if (!error && newPosition) {
            activePositions.set(newPosition.id, newPosition);
            console.log(`✅ 새 포지션 생성: ${newPosition.id.substring(0, 8)}`);
            console.log(`   증거금: ${margin.toFixed(2)}`);
        }
        
        pendingOrders.delete(orderId);
        
        console.log(`✅ 주문 체결 완료: ${order.symbol} ${order.order_side} at ${price.toFixed(2)}`);
        
        broadcastToClients(JSON.stringify({
            type: 'order_filled',
            data: { orderId, symbol: order.symbol, side: order.order_side, price, size: order.size }
        }));
        
    } catch (error) {
        console.error('주문 체결 에러:', error);
    }
}

// 활성 포지션 로드
async function loadActivePositions() {
    try {
        const { data, error } = await supabase
            .from('trading_positions')
            .select('*')
            .eq('status', 'open');
        
        if (error) throw error;
        
        activePositions.clear();
        data.forEach(position => {
            if (position.status === 'open') {
                activePositions.set(position.id, position);
            }
        });
        
        console.log(`📋 활성 포지션 ${activePositions.size}개 로드됨`);
    } catch (error) {
        console.error('포지션 로드 에러:', error);
    }
}

// 대기 주문 로드
async function loadPendingOrders() {
    try {
        const { data, error } = await supabase
            .from('trading_orders')
            .select('*')
            .eq('status', 'pending')
            .eq('type', 'limit');
        
        if (error) throw error;
        
        const previousSize = pendingOrders.size;
        pendingOrders.clear();
        
        data.forEach(order => {
            pendingOrders.set(order.id, order);
        });
        
        const newOrdersCount = pendingOrders.size - previousSize;
        if (newOrdersCount > 0) {
            console.log(`📌 새 주문 ${newOrdersCount}개 추가됨`);
            data.slice(-newOrdersCount).forEach(order => {
                console.log(`  - ${order.symbol} ${order.order_side} @ $${parseFloat(order.price).toFixed(2)}`);
            });
        }
        
        if (pendingOrders.size > 0 && previousSize === 0) {
            console.log(`📋 대기 주문 ${pendingOrders.size}개 로드됨`);
        }
        
    } catch (error) {
        console.error('주문 로드 에러:', error);
    }
}

// 클라이언트에게 브로드캐스트
function broadcastToClients(data) {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// WebSocket 클라이언트 연결 처리
wss.on('connection', (ws, req) => {
    console.log('👤 새 WebSocket 클라이언트 연결');
    clients.add(ws);
    
    ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        message: '서버에 연결되었습니다'
    }));
    
    const prices = {};
    lastPrices.forEach((price, symbol) => {
        prices[symbol] = price;
    });
    
    ws.send(JSON.stringify({
        type: 'current_prices',
        data: prices
    }));
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // WebSocket을 통한 알림도 처리 가능
            if (data.action === 'new_order') {
                console.log('📝 WebSocket으로 새 주문 알림 받음');
                await loadPendingOrders();
            }
        } catch (error) {
            console.error('메시지 처리 에러:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('👤 WebSocket 클라이언트 연결 종료');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('클라이언트 에러:', error);
        clients.delete(ws);
    });
});

// 서버 시작
async function startServer() {
    console.log('\n========================================');
    console.log('🚀 Bybit Trading Server 시작 (개선 버전)');
    console.log('========================================');
    console.log(`🕰️  시간: ${new Date().toLocaleString('ko-KR')}`);
    console.log(`🌐 Supabase URL: ${process.env.SUPABASE_URL}`);
    console.log(`🔑 Service Key: ${process.env.SUPABASE_SERVICE_KEY ? '✅ 설정됨' : '❌ 누락'}`);
    console.log('========================================');
    console.log('📌 주요 개선사항:');
    console.log('  - Realtime 제거 (안정성 향상)');
    console.log('  - HTTP 엔드포인트 추가 (/new-order, /cancel-order, /status)');
    console.log('  - 가격 로그 제한 (1000번에 1번)');
    console.log('  - 즉시 주문 알림 처리');
    console.log('========================================\n');
    
    if (!process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY === 'your_service_key_here_from_supabase_dashboard') {
        console.error('❌ 서비스 키가 설정되지 않았습니다!');
        process.exit(1);
    }
    
    // Bybit 연결
    connectBybit();
    
    // 주기적 동기화 (백업용 - 10초마다)
    setInterval(async () => {
        // 조용히 체크 (로그 없이)
        const { data } = await supabase
            .from('trading_orders')
            .select('*')
            .eq('status', 'pending')
            .eq('type', 'limit');
        
        if (data && data.length !== pendingOrders.size) {
            console.log('🔄 주문 동기화 필요 감지');
            await loadPendingOrders();
        }
    }, 10000); // 10초마다 백업 체크
    
    // HTTP 서버 시작
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
        console.log(`\n✅ 서버가 포트 ${PORT}에서 실행 중`);
        console.log(`🌐 WebSocket: ws://localhost:${PORT}`);
        console.log(`🌐 HTTP 엔드포인트:`);
        console.log(`   POST /new-order - 새 주문 알림`);
        console.log(`   POST /cancel-order - 주문 취소 알림`);
        console.log(`   GET /status - 서버 상태 확인`);
        console.log('\n💡 테스트 방법:');
        console.log('  1. Trading 페이지에서 리밋 주문 생성');
        console.log('  2. 서버 로그에서 "새 주문 알림 받음" 확인');
        console.log('  3. 가격 도달 시 "체결 조건 충족" 확인\n');
    });
}

// 종료 처리
process.on('SIGTERM', () => {
    console.log('🛑 서버 종료 중...');
    shouldReconnect = false;
    bybitWS?.close();
    wss.close(() => {
        process.exit(0);
    });
});

// 서버 시작
startServer();