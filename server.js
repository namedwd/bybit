const WebSocket = require('ws');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 계산 헬퍼 함수들
const calculatePnL = (position, currentPrice) => {
  if (!position || !currentPrice) return 0;
  const { side, entry_price, size } = position;
  return side === 'long' 
    ? (currentPrice - entry_price) * size
    : (entry_price - currentPrice) * size;
};

const calculatePnLPercentage = (pnl, margin) => {
  if (!margin || margin === 0) return 0;
  return (pnl / margin) * 100;
};

const LIQUIDATION_THRESHOLD = -80; // 청산 임계값
const WARNING_THRESHOLD = -70;     // 경고 임계값

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

// 🔥 청산 체크 관리
const closingPositions = new Set(); // 청산 중인 포지션 (중복 방지)
const lastOrderCheckTime = new Map(); // 주문 체크는 스로틀링

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

// 가격 업데이트 처리 (청산은 매번, 주문은 스로틀링)
async function handlePriceUpdate(data) {
    if (!data.data || data.data.length === 0) return;
    
    const trade = data.data[0];
    const symbol = data.topic.split('.')[1];
    const price = parseFloat(trade.p);
    
    // 현재 가격 저장
    lastPrices.set(symbol, price);
    
    // 가격 로그 제한 (1000번에 1번)
    if (++priceLogCounter % PRICE_LOG_INTERVAL === 0) {
        console.log(`💹 ${symbol}: ${price.toFixed(2)} | 포지션: ${activePositions.size}개 | 대기주문: ${pendingOrders.size}개`);
    }
    
    // 🔥 포지션 청산 체크 (매 틱마다 - 메모리 연산이므로 부하 없음)
    checkLiquidations(symbol, price);
    
    // 🔥 주문 체크는 스로틀링 (DB 작업 있으므로)
    const now = Date.now();
    const lastCheck = lastOrderCheckTime.get(symbol) || 0;
    
    if (now - lastCheck >= 100) { // 100ms 간격
        lastOrderCheckTime.set(symbol, now);
        // 비동기로 처리
        setImmediate(() => checkPendingOrders(symbol, price));
    }
}

// 🔥 새로운 청산 체크 함수 (매 틱마다 실행 - 메모리 연산만)
function checkLiquidations(symbol, currentPrice) {
    // 해당 심볼의 포지션만 체크
    for (const [positionId, position] of activePositions) {
        // 이미 청산 중이거나 닫힌 포지션은 스킵
        if (closingPositions.has(positionId) || position.status !== 'open') {
            continue;
        }
        
        if (position.symbol !== symbol) continue;
        
        // PnL 계산 (헬퍼 함수 사용)
        const pnl = calculatePnL(position, currentPrice);
        const pnlPercentage = calculatePnLPercentage(pnl, position.margin);
        
        // 청산선 도달 체크
        if (pnlPercentage <= LIQUIDATION_THRESHOLD) {
            // 중복 방지 플래그 설정
            closingPositions.add(positionId);
            
            console.log(`\n🚨 청산 트리거!`);
            console.log(`   심볼: ${symbol}`);
            console.log(`   포지션: ${position.side.toUpperCase()}`);
            console.log(`   진입가: ${position.entry_price.toFixed(2)}`);
            console.log(`   현재가: ${currentPrice.toFixed(2)}`);
            console.log(`   손실률: ${pnlPercentage.toFixed(2)}%`);
            console.log(`   손실액: ${Math.abs(pnl).toFixed(2)}\n`);
            
            // 비동기로 DB 처리 (메인 스레드 블로킹 방지)
            setImmediate(async () => {
                await executeLiquidation(positionId, position, currentPrice, pnl);
            });
        }
        // 청산 경고 (선택적)
        else if (pnlPercentage <= WARNING_THRESHOLD && pnlPercentage > LIQUIDATION_THRESHOLD) {
            // 10초에 한 번만 경고 (스팸 방지)
            const now = Date.now();
            if (!position.lastWarning || now - position.lastWarning > 10000) {
                position.lastWarning = now;
                console.log(`⚠️  청산 임박: ${symbol} ${position.side} | 손실: ${pnlPercentage.toFixed(2)}%`);
            }
        }
        
        // 익절/손절 체크
        if (position.tp_price || position.sl_price) {
            let shouldClose = false;
            let closeReason = '';
            
            if (position.side === 'long') {
                if (position.tp_price && currentPrice >= position.tp_price) {
                    shouldClose = true;
                    closeReason = 'tp';
                    console.log(`💰 익절 도달: ${symbol} LONG @ ${currentPrice.toFixed(2)}`);
                } else if (position.sl_price && currentPrice <= position.sl_price) {
                    shouldClose = true;
                    closeReason = 'sl';
                    console.log(`🛑 손절 도달: ${symbol} LONG @ ${currentPrice.toFixed(2)}`);
                }
            } else { // short
                if (position.tp_price && currentPrice <= position.tp_price) {
                    shouldClose = true;
                    closeReason = 'tp';
                    console.log(`💰 익절 도달: ${symbol} SHORT @ ${currentPrice.toFixed(2)}`);
                } else if (position.sl_price && currentPrice >= position.sl_price) {
                    shouldClose = true;
                    closeReason = 'sl';
                    console.log(`🛑 손절 도달: ${symbol} SHORT @ ${currentPrice.toFixed(2)}`);
                }
            }
            
            if (shouldClose && !closingPositions.has(positionId)) {
                closingPositions.add(positionId);
                setImmediate(async () => {
                    await closePosition(positionId, currentPrice, closeReason, pnl);
                });
            }
        }
    }
}

// 청산 실행 함수 (DB 작업)
async function executeLiquidation(positionId, position, price, pnl) {
    try {
        // DB 함수 호출
        const { data: result, error } = await supabase.rpc('close_position_with_balance', {
            p_position_id: positionId,
            p_close_price: price,
            p_pnl: pnl,
            p_close_reason: 'liquidation'
        });
        
        if (error) throw error;
        
        if (result && result.success) {
            // 메모리에서 제거
            activePositions.delete(positionId);
            closingPositions.delete(positionId);
            
            console.log(`✅ 청산 완료!`);
            console.log(`   반환 금액: $0 (청산으로 인한 전액 손실)`);
            console.log(`   새 잔고: ${result.new_balance.toFixed(2)}\n`);
            
            // 클라이언트에게 알림
            broadcastToClients(JSON.stringify({
                type: 'liquidation',
                data: {
                    positionId,
                    symbol: position.symbol,
                    side: position.side,
                    loss: Math.abs(pnl),
                    newBalance: result.new_balance
                }
            }));
        }
    } catch (error) {
        console.error('청산 실행 오류:', error);
        // 실패 시 플래그 제거 (재시도 가능하도록)
        closingPositions.delete(positionId);
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

// 주문 체결 (포지션 통합 방식) - 🔥 잔고 체크 제거!
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
        
        // 🔥 리밋 주문은 이미 생성 시점에 잔고를 확인했으므로
        // 체결 시점에 추가 잔고 체크 불필요 - 제거!
        const margin = (order.size * price) / order.leverage;
        console.log(`✅ 리밋 주문 체결 진행: 예약된 증거금 ${margin.toFixed(2)} 사용`);
        
        console.log(`📝 주문 체결 처리:`, {
            orderId: orderId.substring(0, 8),
            symbol: order.symbol,
            side: order.order_side,
            size: order.size,
            orderPrice: order.price,
            fillPrice: price
        });
        
        // 🔥 fill_limit_order 함수로 전체 처리 (상태 변경 + 포지션 생성)
        const { data: result, error } = await supabase.rpc('fill_limit_order', {
            p_order_id: orderId,
            p_fill_price: price
        });
        
        if (error) {
            console.error('포지션 처리 에러:', error);
            
            // 주문을 다시 pending으로 복구
            pendingOrders.set(orderId, order);
            return;
        }
        
        if (!result || !result.success) {
            console.error('포지션 생성 실패:', result?.error || '알 수 없는 오류');
            
            // 주문 취소 처리
            await supabase
                .from('trading_orders')
                .update({
                    status: 'cancelled',
                    close_reason: result?.error || '포지션 생성 실패'
                })
                .eq('id', orderId);
            
            return;
        }
        
        if (result.success) {
            // 포지션 다시 로드
            await loadActivePositions();
            
            if (result.action === 'merged') {
                console.log(`✅ 포지션 추가: ${order.symbol} ${order.order_side}`);
                console.log(`   포지션 ID: ${result.position_id}`);
            } else {
                console.log(`✅ 새 포지션 생성: ${order.symbol} ${order.order_side}`);
                console.log(`   포지션 ID: ${result.position_id}`);
            }
        }
        
        console.log(`✅ 주문 체결 완료: ${order.symbol} ${order.order_side} at ${price.toFixed(2)}`);
        
        broadcastToClients(JSON.stringify({
            type: 'order_filled',
            data: { 
                orderId, 
                symbol: order.symbol, 
                side: order.order_side, 
                price, 
                size: order.size,
                action: result?.action || 'created'
            }
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
    console.log('📌 주요 기능:');
    console.log('  ✅ 실시간 청산 모니터링 (매 틱마다)');
    console.log('  ✅ 익절/손절 자동 실행');
    console.log('  ✅ Limit 주문 자동 체결 (잔고 중복 체크 제거)');
    console.log('  ✅ -80% 도달 시 자동 청산');
    console.log('  ✅ -70% 도달 시 경고 알림');
    console.log('========================================');
    console.log('🔥 개선사항:');
    console.log('  - 리밋 주문 체결 시 잔고 체크 제거');
    console.log('  - 이미 주문 생성 시 확인한 증거금 사용');
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
    
    // 🔥 백업 청산 체크 (1초마다 - 혹시 놓친 청산 처리)
    setInterval(() => {
        if (activePositions.size === 0) return;
        
        for (const [symbol, price] of lastPrices) {
            // 메모리 연산이므로 부담 없음
            checkLiquidations(symbol, price);
        }
    }, 1000); // 1초마다 백업 체크
    
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
        console.log('  3. 가격 도달 시 "체결 조건 충족" 확인');
        console.log('  4. 잔고 부족 오류 없이 체결 완료 확인\n');
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