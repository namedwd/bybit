const WebSocket = require('ws');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Supabase 클라이언트 초기화
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY // service key 사용 (서버용)
);

// HTTP 서버 생성
const server = http.createServer();
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

// Bybit WebSocket 연결 함수
function connectBybit() {
    // Bybit 선물 WebSocket (레버리지 거래용)
    bybitWS = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    
    bybitWS.on('open', async () => {
        console.log('✅ Bybit WebSocket 연결됨');
        
        // 구독할 심볼들
        const subscribeMsg = {
            op: "subscribe",
            args: [
                // BTC
                "publicTrade.BTCUSDT",
                "orderbook.50.BTCUSDT",
                "tickers.BTCUSDT",
                "liquidation.BTCUSDT",
                "kline.1.BTCUSDT",
                // ETH
                "publicTrade.ETHUSDT",
                "orderbook.50.ETHUSDT",
                "tickers.ETHUSDT",
                "liquidation.ETHUSDT",
                "kline.1.ETHUSDT",
                // SOL 추가
                "publicTrade.SOLUSDT",
                "orderbook.50.SOLUSDT",
                "tickers.SOLUSDT",
            ]
        };
        
        bybitWS.send(JSON.stringify(subscribeMsg));
        console.log('📡 구독 요청 전송됨');
        
        // 활성 포지션/주문 로드
        await loadActivePositions();
        await loadPendingOrders();
        
        // 초기 로드 후 즉시 체크
        console.log('\n🔍 초기 주문 체크 시작...');
        setTimeout(() => {
            // 모든 심볼에 대해 현재 가격으로 체크
            for (const [symbol, price] of lastPrices) {
                console.log(`초기 체크: ${symbol} @ ${price.toFixed(2)}`);
                checkPendingOrders(symbol, price);
            }
        }, 3000); // 3초 후 체크 (가격 데이터 수신 대기)
        
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
        
        // Pong 응답 무시
        if (parsedData.op === 'pong') return;
        
        // 실시간 체결가 처리
        if (parsedData.topic && parsedData.topic.includes('publicTrade')) {
            await handlePriceUpdate(parsedData);
        }
        
        // 모든 클라이언트에게 데이터 브로드캐스트
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
    const symbol = data.topic.split('.')[1]; // BTCUSDT, ETHUSDT 등
    const price = parseFloat(trade.p);
    
    // 현재 가격 저장
    lastPrices.set(symbol, price);
    
    // 디버깅: 가격 업데이트 로그 (매 100번째 업데이트마다)
    if (Math.random() < 0.01) { // 1% 확률로 로그
        console.log(`💹 ${symbol} 현재가: ${price.toFixed(2)}, 대기 주문: ${pendingOrders.size}개`);
    }
    
    // 포지션 체크 (익절/손절/청산)
    await checkPositions(symbol, price);
    
    // 대기 주문 체크
    await checkPendingOrders(symbol, price);
}

// 포지션 체크 (익절/손절/청산)
async function checkPositions(symbol, currentPrice) {
    // 체크 전에 DB에서 최신 상태 확인
    const positionsToCheck = [];
    
    for (const [positionId, position] of activePositions) {
        if (position.symbol === symbol && position.status === 'open') {
            positionsToCheck.push({ id: positionId, ...position });
        }
    }
    
    // 각 포지션 체크
    for (const position of positionsToCheck) {
        // DB에서 현재 상태 재확인 (중복 방지)
        const { data: currentPosition, error } = await supabase
            .from('trading_positions')
            .select('status')
            .eq('id', position.id)
            .single();
        
        if (error || !currentPosition || currentPosition.status !== 'open') {
            // 이미 닫혔거나 없는 포지션은 메모리에서 제거
            activePositions.delete(position.id);
            continue;
        }
        
        let shouldClose = false;
        let closeReason = '';
        
        // 익절/손절 체크
        if (position.side === 'long') {
            if (position.tp_price && currentPrice >= position.tp_price) {
                shouldClose = true;
                closeReason = 'tp'; // Take Profit
            } else if (position.sl_price && currentPrice <= position.sl_price) {
                shouldClose = true;
                closeReason = 'sl'; // Stop Loss
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
        
        // PnL 계산
        const pnl = calculatePnL(position, currentPrice);
        const pnlPercentage = (pnl / position.margin) * 100;
        
        // 청산 체크 (마진의 -80% 손실)
        if (pnlPercentage <= -80) {
            shouldClose = true;
            closeReason = 'liquidation';
        }
        
        // 포지션 종료
        if (shouldClose) {
            await closePosition(position.id, currentPrice, closeReason, pnl);
        } else {
            // PnL 업데이트만
            await updatePositionPnL(position.id, currentPrice, pnl, pnlPercentage);
        }
    }
}

// 대기 주문 체크
async function checkPendingOrders(symbol, currentPrice) {
    // 매번 로그 (디버깅용)
    if (pendingOrders.size > 0) {
        // 주기적으로 상세 로그 출력
        if (Math.random() < 0.05) { // 5% 확률로 상세 로그
            console.log(`\n====== 주문 체크 ======`);
            console.log(`📋 심볼: ${symbol}`);
            console.log(`💵 현재가: ${currentPrice.toFixed(2)}`);
            console.log(`📝 대기 주문 수: ${pendingOrders.size}`);
            
            for (const [orderId, order] of pendingOrders) {
                console.log(`  - ${order.symbol} ${order.order_side} @ ${parseFloat(order.price).toFixed(2)}`);
            }
            console.log(`====================\n`);
        }
    }
    
    for (const [orderId, order] of pendingOrders) {
        // 심볼 체크
        if (order.symbol !== symbol) {
            continue;
        }
        
        // 상태 체크 (pending이 아니면 스킵)
        if (order.status !== 'pending') {
            console.log(`⚠️ 주문 ${orderId}는 pending이 아님: ${order.status}`);
            pendingOrders.delete(orderId);
            continue;
        }
        
        let shouldFill = false;
        const orderPrice = parseFloat(order.price);
        
        // Limit 주문 체결 조건
        if (order.type === 'limit') {
            // Buy/Long 주문: 현재가가 주문가 이하로 떨어질 때
            const isBuyOrder = order.side === 'buy' || order.order_side === 'buy';
            const isSellOrder = order.side === 'sell' || order.order_side === 'sell';
            
            if (isBuyOrder && currentPrice <= orderPrice) {
                shouldFill = true;
                console.log(`\n🎯 Buy Limit 체결 조건 충족!`);
                console.log(`  심볼: ${symbol}`);
                console.log(`  현재가: ${currentPrice.toFixed(2)}`);
                console.log(`  주문가: ${orderPrice.toFixed(2)}`);
                console.log(`  조건: ${currentPrice.toFixed(2)} <= ${orderPrice.toFixed(2)}\n`);
            } 
            // Sell/Short 주문: 현재가가 주문가 이상으로 오를 때
            else if (isSellOrder && currentPrice >= orderPrice) {
                shouldFill = true;
                console.log(`\n🎯 Sell Limit 체결 조건 충족!`);
                console.log(`  심볼: ${symbol}`);
                console.log(`  현재가: ${currentPrice.toFixed(2)}`);
                console.log(`  주문가: ${orderPrice.toFixed(2)}`);
                console.log(`  조건: ${currentPrice.toFixed(2)} >= ${orderPrice.toFixed(2)}\n`);
            }
        }
        
        if (shouldFill) {
            console.log(`\n🚀 주문 체결 프로세스 시작: ${orderId}\n`);
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

// 포지션 종료
async function closePosition(positionId, price, reason, pnl) {
    try {
        const position = activePositions.get(positionId);
        if (!position) return;
        
        // 중복 방지: 이미 처리 중이거나 닫힌 포지션인지 DB에서 확인
        const { data: currentStatus, error: statusError } = await supabase
            .from('trading_positions')
            .select('status')
            .eq('id', positionId)
            .single();
        
        if (statusError || !currentStatus || currentStatus.status !== 'open') {
            console.log(`포지션 ${positionId}는 이미 처리됨 (status: ${currentStatus?.status})`);
            activePositions.delete(positionId);
            return;
        }
        
        // Supabase 업데이트
        const { error: posError } = await supabase
            .from('trading_positions')
            .update({
                status: reason === 'liquidation' ? 'liquidated' : 'closed',
                mark_price: price,
                pnl: pnl,
                pnl_percentage: (pnl / position.margin) * 100,
                closed_at: new Date().toISOString(),
                close_reason: reason
            })
            .eq('id', positionId);
        
        if (posError) throw posError;
        
        // 잔고 업데이트
        const returnAmount = reason === 'liquidation' ? 0 : position.margin + pnl;
        
        if (returnAmount > 0) {
            // 현재 잔고 가져오기
            const { data: userData, error: userError } = await supabase
                .from('trading_users')
                .select('balance')
                .eq('id', position.user_id)
                .single();
            
            if (!userError && userData) {
                const newBalance = parseFloat(userData.balance) + returnAmount;
                
                const { error: balError } = await supabase
                    .from('trading_users')
                    .update({ balance: newBalance })
                    .eq('id', position.user_id);
                
                if (balError) throw balError;
            }
        }
        
        // 거래 내역 저장
        await supabase.from('trading_trades').insert({
            user_id: position.user_id,
            position_id: positionId,
            symbol: position.symbol,
            side: position.side === 'long' ? 'sell' : 'buy', // 반대 포지션으로 종료
            size: position.size,
            price: price,
            realized_pnl: pnl,
            trade_type: reason
        });
        
        // 메모리에서 제거
        activePositions.delete(positionId);
        
        console.log(`📊 포지션 종료: ${position.symbol.replace('USDT', 'USD')} ${reason.toUpperCase()} at ${price}, PnL: ${pnl.toFixed(2)}`);
        
        // 클라이언트에 알림
        broadcastToClients(JSON.stringify({
            type: 'position_closed',
            data: {
                positionId,
                reason,
                price,
                pnl
            }
        }));
        
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
            
        // 메모리 업데이트
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
        if (!order) {
            console.log(`❌ 주문을 찾을 수 없음: ${orderId}`);
            return;
        }
        
        console.log(`📝 주문 체결 처리 중:`, {
            orderId,
            symbol: order.symbol,
            side: order.order_side,
            size: order.size,
            orderPrice: order.price,
            fillPrice: price
        });
        
        // 주문 상태 업데이트
        const { error: updateError } = await supabase
            .from('trading_orders')
            .update({
                status: 'filled',
                filled_price: price,
                filled_at: new Date().toISOString()
            })
            .eq('id', orderId);
        
        if (updateError) {
            console.error('주문 업데이트 에러:', updateError);
            return;
        }
        
        // 새 포지션 생성
        // size는 이미 달러 금액이 아닌 BTC 수량이어야 함
        const margin = (order.size * price) / order.leverage;
        
        // 잔고 차감
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
            // 메모리에 추가
            activePositions.set(newPosition.id, newPosition);
            console.log(`✅ 새 포지션 생성됨: ${newPosition.id}`);
        } else if (error) {
            console.error('포지션 생성 에러:', error);
        }
        
        // 메모리에서 제거
        pendingOrders.delete(orderId);
        
        console.log(`✅ 주문 체결 완료: ${order.symbol.replace('USDT', 'USD')} ${order.order_side} at ${price}`);
        
        // 클라이언트에 알림
        broadcastToClients(JSON.stringify({
            type: 'order_filled',
            data: {
                orderId,
                symbol: order.symbol,
                side: order.order_side,
                price,
                size: order.size
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
            // status가 'open'인 것만 메모리에 추가
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
        
        pendingOrders.clear();
        data.forEach(order => {
            pendingOrders.set(order.id, order);
            console.log(`📌 대기 주문 로드: ${order.symbol} ${order.order_side} @ ${parseFloat(order.price).toFixed(2)}`);
        });
        
        console.log(`📋 총 대기 주문 ${pendingOrders.size}개 로드됨`);
        
        // 현재 가격과 비교
        for (const [symbol, price] of lastPrices) {
            console.log(`현재 ${symbol} 가격: ${price.toFixed(2)}`);
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

// 클라이언트 연결 처리
wss.on('connection', (ws, req) => {
    console.log('👤 새 클라이언트 연결');
    clients.add(ws);
    
    // 연결 확인 메시지
    ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        message: '서버에 연결되었습니다'
    }));
    
    // 현재 가격 전송
    const prices = {};
    lastPrices.forEach((price, symbol) => {
        prices[symbol] = price;
    });
    
    ws.send(JSON.stringify({
        type: 'current_prices',
        data: prices
    }));
    
    // 클라이언트 메시지 처리
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // 새 포지션/주문 알림 처리
            if (data.action === 'position_created') {
                await loadActivePositions();
            } else if (data.action === 'order_created') {
                await loadPendingOrders();
            }
        } catch (error) {
            console.error('메시지 처리 에러:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('👤 클라이언트 연결 종료');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('클라이언트 에러:', error);
        clients.delete(ws);
    });
});

// Supabase 실시간 구독 (새 포지션/주문 감지)
async function setupSupabaseSubscriptions() {
    // 포지션 변경 감지 (INSERT, UPDATE, DELETE)
    supabase
        .channel('positions')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'trading_positions'
        }, async (payload) => {
            if (payload.new.status === 'open') {
                activePositions.set(payload.new.id, payload.new);
                console.log('📍 새 포지션 추가됨');
            }
        })
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'trading_positions'
        }, async (payload) => {
            // 포지션이 closed 또는 liquidated로 변경되면 즉시 메모리에서 제거
            if (payload.new.status === 'closed' || payload.new.status === 'liquidated') {
                activePositions.delete(payload.new.id);
                console.log(`📊 포지션 ${payload.new.id} 메모리에서 즉시 제거됨 (status: ${payload.new.status}, reason: ${payload.new.close_reason})`);
                
                // 클라이언트에게 알림
                broadcastToClients(JSON.stringify({
                    type: 'position_removed_from_memory',
                    data: {
                        positionId: payload.new.id,
                        status: payload.new.status,
                        reason: payload.new.close_reason
                    }
                }));
            } else if (payload.new.status === 'open') {
                // 포지션 정보 업데이트
                activePositions.set(payload.new.id, payload.new);
            }
        })
        .on('postgres_changes', {
            event: 'DELETE',
            schema: 'public',
            table: 'trading_positions'
        }, async (payload) => {
            activePositions.delete(payload.old.id);
            console.log(`🗑️ 포지션 ${payload.old.id} 삭제됨`);
        })
        .subscribe();
    
    // 새 주문 감지
    supabase
        .channel('orders')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'trading_orders'
        }, async (payload) => {
            if (payload.new.status === 'pending' && payload.new.type === 'limit') {
                pendingOrders.set(payload.new.id, payload.new);
                console.log(`📝 새 주문 추가됨: ${payload.new.symbol} ${payload.new.order_side} @ ${parseFloat(payload.new.price).toFixed(2)}`);
                
                // 현재 가격과 즉시 비교
                const currentPrice = lastPrices.get(payload.new.symbol);
                if (currentPrice) {
                    console.log(`현재 ${payload.new.symbol} 가격: ${currentPrice.toFixed(2)}`);
                    // 즉시 체결 체크
                    await checkPendingOrders(payload.new.symbol, currentPrice);
                }
            }
        })
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'trading_orders'
        }, async (payload) => {
            // 주문이 취소되거나 체결되면 메모리에서 제거
            if (payload.new.status !== 'pending') {
                pendingOrders.delete(payload.new.id);
                console.log(`📝 주문 제거됨: ${payload.new.id} (status: ${payload.new.status})`);
            }
        })
        .subscribe();
}

// 서버 시작
async function startServer() {
    console.log('\n========================================');
    console.log('🚀 Bybit Trading Server 시작 중...');
    console.log('========================================');
    console.log(`🕰️  시간: ${new Date().toLocaleString('ko-KR')}`);
    console.log(`🌐 Supabase URL: ${process.env.SUPABASE_URL}`);
    console.log(`🔑 Service Key: ${process.env.SUPABASE_SERVICE_KEY ? '✅ 설정됨' : '❌ 누락'}`);
    console.log('========================================\n');
    
    if (!process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY === 'your_service_key_here_from_supabase_dashboard') {
        console.error('❌ ❌ ❌ 서비스 키가 설정되지 않았습니다!');
        console.error('💡 .env 파일에 SUPABASE_SERVICE_KEY를 설정하세요.');
        console.error('💡 Supabase Dashboard > Settings > API > service_role key를 복사하세요.\n');
        process.exit(1);
    }
    
    // Bybit 연결
    connectBybit();
    
    // Supabase 구독 설정
    await setupSupabaseSubscriptions();
    
    // 주기적 동기화 (30초마다 - 디버깅용)
    setInterval(async () => {
        console.log(`\n🔄 주기적 동기화... [${new Date().toLocaleTimeString('ko-KR')}]`);
        await loadActivePositions();
        await loadPendingOrders();
        
        // 현재 가격 표시
        if (lastPrices.size > 0) {
            console.log('💰 현재 가격:');
            for (const [symbol, price] of lastPrices) {
                console.log(`  ${symbol}: ${price.toFixed(2)}`);
            }
        }
    }, 30000); // 30초마다
    
    // HTTP 서버 시작
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
        console.log(`\n✅ WebSocket 서버가 포트 ${PORT}에서 실행 중`);
        console.log(`🌐 http://localhost:${PORT}`);
        console.log('\n💡 리밋 주문 테스트:');
        console.log('  1. 현재가보다 낮은 가격에 Buy Limit 주문');
        console.log('  2. 현재가보다 높은 가격에 Sell Limit 주문');
        console.log('  3. 가격이 주문가에 도달하면 자동 체결\n');
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
