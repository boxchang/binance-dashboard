import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  RefreshCw, Wifi, WifiOff, AlertTriangle, Cpu, 
  CheckCircle, Play, Pause, ChevronLeft, ChevronRight 
} from 'lucide-react';

// 實用工具：延遲器（防止請求過於密集，規避 429 頻率限制）
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 標準 Wilder's Smoothing RSI 計算函數 ---
const calculateWildersRSI = (klines, period = 6) => {
  if (!klines || klines.length <= period) return 50;

  const prices = klines.map(k => parseFloat(k[4]));
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const gains = changes.map(c => (c > 0 ? c : 0));
  const losses = changes.map(c => (c < 0 ? -c : 0));

  let avgGain = gains.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

// --- 合併全域 API 數據獲取 (節省 API 請求次數) ---
const fetchGlobalBinanceData = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    // 一次性取得所有期貨交易對的 24h Ticker 和 資金費率
    const [tickerRes, fundingRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { signal: controller.signal }),
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { signal: controller.signal })
    ]);

    clearTimeout(timeoutId);

    if (!tickerRes.ok || !fundingRes.ok) throw new Error('Global API Error');

    const tickers = await tickerRes.json();
    const fundings = await fundingRes.json();

    // 轉換為 Map 加快查找效率
    const tickerMap = {};
    tickers.forEach(t => { tickerMap[t.symbol] = t; });

    const fundingMap = {};
    fundings.forEach(f => { fundingMap[f.symbol] = f; });

    return { tickerMap, fundingMap };
  } catch (err) {
    return null;
  }
};

// --- 單一幣種深度數據獲取 (K線與持倉量) ---
const fetchSymbolDetails = async (symbol) => {
  try {
    const s = symbol.toUpperCase();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const [klinesRes, oiRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=1h&limit=100`, { signal: controller.signal }),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${s}`, { signal: controller.signal })
    ]);

    clearTimeout(timeoutId);

    if (!klinesRes.ok || !oiRes.ok) throw new Error('Details API Error');

    const klines = await klinesRes.json();
    const oiData = await oiRes.json();

    return { klines, openInterest: oiData.openInterest };
  } catch (err) {
    return null;
  }
};

const DetailedCard = ({ data, isSignal = false }) => {
  // 如果 API 失敗，展示不可用狀態
  if (data.isError) {
    return (
      <div className="bg-[#1e2329]/50 border border-red-950 rounded-lg p-3 flex flex-col justify-between h-[104px]">
        <div className="flex justify-between items-center">
          <span className="font-bold text-gray-500 text-xs tracking-wider">{data.symbol}</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-950/80 text-red-400 font-bold">OFFLINE</span>
        </div>
        <div className="text-[10px] text-red-400 font-mono italic">API 讀取錯誤</div>
      </div>
    );
  }

  const rsiColor = data.rsi > 75 ? 'text-red-500 font-bold' : data.rsi < 25 ? 'text-green-500 font-bold' : 'text-gray-200';
  const isUp = parseFloat(data.change) >= 0;
  
  return (
    <div className={`bg-[#1e2329] border rounded-lg p-3 transition-all duration-300 hover:scale-[1.02] ${isSignal ? 'border-[#f0b90b] shadow-[0_0_12px_rgba(240,185,11,0.15)] bg-[#242a32]' : 'border-[#2b3139]'}`}>
      <div className="flex justify-between items-center mb-2 border-b border-[#363c4e] pb-1.5">
        <div className="flex flex-col">
          <span className="font-bold text-white text-xs tracking-wider">{data.symbol}</span>
          <span className="text-[10px] text-gray-400 font-mono">${data.price || '0.00'}</span>
        </div>
        {isSignal && (
          <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-wider ${
            data.signal === 'STRONG BUY' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
          }`}>
            {data.signal}
          </span>
        )}
      </div>
      {isSignal && (
        <div className="text-[9px] text-[#f0b90b] mb-2 italic truncate bg-[#14151a] p-1 rounded">
          💡 原因: {data.reason}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-[9px] text-gray-400 font-mono">
        <div>資金費率: <span className="text-gray-100">{data.funding}</span></div>
        <div>動能漲跌: <span className={isUp ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>
          {isUp ? '+' : ''}{data.change}%
        </span></div>
        <div>RSI (6): <span className={rsiColor}>{data.rsi.toFixed(1)}</span></div>
        
        {/* 新增：OI 持倉量及變化顯示 */}
        <div className="flex items-center gap-1 whitespace-nowrap">
          持倉(OI): <span className="text-gray-100">{data.oi}</span>
          {data.oiChange !== undefined && data.oiChange !== 0 ? (
            <span className={`text-[8.5px] font-bold ${data.oiChange > 0 ? 'text-green-400' : 'text-red-400'}`}>
              {data.oiChange > 0 ? '▲' : '▼'}{Math.abs(data.oiChange).toFixed(1)}%
            </span>
          ) : (
            <span className="text-[8.5px] text-gray-600">-</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [symbols] = useState([
    'ANTHROPICUSDT','SPCXUSDT'
  ]);
  
  const [marketData, setMarketData] = useState([]);
  const [isUpdating, setIsUpdating] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 48, activeSymbol: '' });
  
  // 分頁狀態
  const [currentPage, setCurrentPage] = useState(0);
  const [isPaused, setIsPaused] = useState(false); // 新增：暫停輪播功能
  
  const [lastUpdated, setLastUpdated] = useState('');
  const [hasCorsError, setHasCorsError] = useState(false);

  const isUpdatingRef = useRef(false);
  const prevDataRef = useRef({});
  const ITEMS_PER_PAGE = 16;

  const refresh = useCallback(async () => {
    if (isUpdatingRef.current) return;
    isUpdatingRef.current = true;
    setIsUpdating(true);
    
    let updatedData = [];

    setScanProgress({ current: 0, total: symbols.length, activeSymbol: '讀取 Binance 全域行情...' });
    const globalBinanceData = await fetchGlobalBinanceData();

    if (!globalBinanceData) {
      setHasCorsError(true);
      updatedData = symbols.map(sym => ({
        symbol: sym,
        isError: true
      }));
    } else {
      setHasCorsError(false);
      const { tickerMap, fundingMap } = globalBinanceData;

      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        setScanProgress({ current: i + 1, total: symbols.length, activeSymbol: `讀取實時數據: ${sym}...` });

        const detail = await fetchSymbolDetails(sym);
        
        await sleep(150);

        const ticker = tickerMap[sym];
        const funding = fundingMap[sym];

        if (detail && ticker && funding) {
          const rsiValue = calculateWildersRSI(detail.klines, 6);
          const priceChangePct = parseFloat(ticker.priceChangePercent);
          const oiValue = parseFloat(detail.openInterest);
          const fundingRate = parseFloat(funding.lastFundingRate);

          // 獲取前一次更新的 OI 數據來計算增長率
          const prevData = prevDataRef.current[sym];
          const prevOiValue = (prevData && !prevData.isError && prevData.rawOi) ? prevData.rawOi : oiValue;
          
          let oiChangePct = 0;
          if (prevOiValue > 0) {
            oiChangePct = ((oiValue - prevOiValue) / prevOiValue) * 100;
          }

          let signal = 'HOLD';
          let reason = '';
          if (rsiValue < 25) {
            signal = 'STRONG BUY';
            reason = '極度超賣 (RSI < 25)';
          } else if (rsiValue < 38 && priceChangePct > 0) {
            signal = 'STRONG BUY';
            reason = 'RSI 低位 ＆ 動能轉強';
          } else if (rsiValue > 78) {
            signal = 'STRONG SELL';
            reason = '極度超買 (RSI > 78)';
          } else if (rsiValue > 62 && priceChangePct < 0) {
            signal = 'STRONG SELL';
            reason = 'RSI 高位 ＆ 動能轉弱';
          }

          const freshData = {
            symbol: sym,
            price: parseFloat(ticker.lastPrice).toFixed(2),
            rsi: rsiValue,
            change: priceChangePct.toFixed(2),
            oi: (oiValue / 1000).toFixed(0) + 'k',
            rawOi: oiValue, // 隱藏存儲真實數值，供下次比對
            oiChange: oiChangePct, // 記錄 OI 變化百分比
            funding: (fundingRate * 100).toFixed(4) + '%',
            signal,
            reason,
            isError: false
          };

          prevDataRef.current[sym] = freshData;
          updatedData.push(freshData);
        } else {
          if (prevDataRef.current[sym]) {
            updatedData.push(prevDataRef.current[sym]);
          } else {
            updatedData.push({ symbol: sym, isError: true });
          }
        }
      }
    }

    setMarketData(updatedData);
    setLastUpdated(new Date().toLocaleTimeString());
    
    setIsUpdating(false);
    isUpdatingRef.current = false;
    
    setScanProgress({ current: symbols.length, total: symbols.length, activeSymbol: '實時掃描完成' });
  }, [symbols]);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(), 300000);
    return () => clearInterval(timer);
  }, [refresh]);

  const activeSignals = marketData.filter(d => !d.isError && d.signal !== 'HOLD');
  const marketMonitoring = marketData.filter(d => d.isError || d.signal === 'HOLD');

  const totalPages = Math.ceil(marketMonitoring.length / ITEMS_PER_PAGE) || 1;

  // 監控分頁器 (加入 isPaused 判斷)
  useEffect(() => {
    if (isPaused) return; // 如果被暫停，就不設定自動輪播計時器

    const pageTimer = setInterval(() => {
      setCurrentPage((prev) => (prev + 1) % totalPages);
    }, 6000);
    return () => clearInterval(pageTimer);
  }, [totalPages, isPaused]);

  // 手動切換分頁控制
  const handlePrevPage = () => {
    setCurrentPage((prev) => (prev - 1 + totalPages) % totalPages);
  };
  const handleNextPage = () => {
    setCurrentPage((prev) => (prev + 1) % totalPages);
  };

  const progressPercentage = Math.min(100, Math.round((scanProgress.current / scanProgress.total) * 100));

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 p-4 font-sans selection:bg-[#f0b90b] selection:text-black">
      {/* 頂部導航欄 */}
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-1 pb-4 border-b border-[#2b3139] gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-extrabold text-[#f0b90b] tracking-wider">BIG WAVE</h1>
            <span className="text-xs bg-[#1e2329] text-gray-400 border border-[#363c4e] px-2 py-0.5 rounded font-mono flex items-center gap-1">
              <Cpu className="w-3 h-3 text-[#f0b90b]" /> 實時防封鎖架構版
            </span>
          </div>
          <p className="text-[10px] text-gray-400 mt-1">智能合併 + 150ms 循序防護佇列 | 自動輪詢：5 分鐘/次</p>
        </div>

        {/* 控制面板 */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[10px] text-gray-500 font-mono bg-[#14151a] px-2.5 py-1.5 rounded border border-[#2b3139]">
            最後同步: {lastUpdated || '數據同步中...'}
          </span>

          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium border ${
            hasCorsError 
              ? 'bg-red-950/40 text-red-400 border-red-800' 
              : 'bg-green-950/40 text-green-400 border-green-800'
          }`}>
            {hasCorsError ? <WifiOff className="w-3.5 h-3.5" /> : <Wifi className="w-3.5 h-3.5" />}
            <span>{hasCorsError ? 'API 連線中斷' : '實時 API 連線中'}</span>
          </div>

          <button
            onClick={() => refresh()}
            disabled={isUpdating}
            className="p-1.5 bg-[#1e2329] border border-[#2b3139] rounded text-gray-300 hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isUpdating ? 'animate-spin text-[#f0b90b]' : ''}`} />
          </button>
        </div>
      </header>

      {/* 交易所動態掃描進度條 */}
      <div className="bg-[#14151a] border border-[#1e2329] p-2 rounded-lg mb-4 flex items-center justify-between text-[11px] gap-4">
        <div className="flex items-center gap-2 shrink-0">
          {isUpdating ? (
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500"></span>
            </span>
          ) : (
            <CheckCircle className="w-3.5 h-3.5 text-green-500" />
          )}
          <span className="text-gray-400">數據流同步進度:</span>
          <span className="text-white font-mono">{scanProgress.activeSymbol}</span>
        </div>
        <div className="w-full max-w-md bg-[#2b3139] rounded-full h-1.5 overflow-hidden">
          <div 
            className="bg-[#f0b90b] h-1.5 transition-all duration-300 ease-out" 
            style={{ width: `${progressPercentage}%` }}
          ></div>
        </div>
        <div className="font-mono text-gray-500 shrink-0">
          {scanProgress.current}/{scanProgress.total} ({progressPercentage}%)
        </div>
      </div>

      {/* CORS / 頻率限制警報 */}
      {hasCorsError && (
        <div className="bg-amber-950/50 border border-amber-500/30 text-amber-300 rounded-lg p-3 mb-4 text-xs flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">連線警告：</span>由於您的瀏覽器存在 
            <span className="underline decoration-amber-500/50 font-mono ml-1">CORS 跨網域限制</span>，或者您的 IP 因呼叫過於頻繁已被幣安伺服器暫時限制（HTTP 429）。
            <br />
            <span className="font-bold text-amber-200 mt-1 block">💡 解決方法：</span>
            建議您在瀏覽器安裝 <strong>Allow CORS</strong> 插件、使用 VPN 切換 IP、或者在本地開啟後端代理伺服器。
          </div>
        </div>
      )}

      {/* 區塊一：關鍵出擊訊號區 */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-ping"></span>
          <h2 className="text-xs uppercase font-extrabold text-red-400 tracking-wider">
            關鍵出擊訊號區 ({activeSignals.length})
          </h2>
        </div>
        
        {activeSignals.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {activeSignals.map(d => (
              <DetailedCard key={d.symbol} data={d} isSignal={true} />
            ))}
          </div>
        ) : (
          <div className="bg-[#14151a] border border-[#2b3139] border-dashed rounded-lg py-8 text-center text-xs text-gray-500">
            ⏳ 當前所有標的均處於強勢持倉或弱勢震盪 (HOLD) 中，雷達實時掃描中...
          </div>
        )}
      </section>

      {/* 區塊二：大波段市場雷達監控區 */}
      <section>
        <div className="flex justify-between items-center mb-2.5">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#f0b90b]"></span>
            <h2 className="text-xs uppercase font-extrabold text-gray-300 tracking-wider">
              大波段市場雷達監控中 ({marketMonitoring.length})
            </h2>
          </div>
          
          {/* 新增：具有暫停及手動翻頁功能的控制區塊 */}
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsPaused(!isPaused)} 
              className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] transition-colors ${
                isPaused 
                  ? 'bg-amber-950/40 border-amber-800 text-amber-400' 
                  : 'bg-[#1e2329] border-[#363c4e] text-gray-400 hover:text-white'
              }`}
              title={isPaused ? '恢復自動輪播' : '暫停自動輪播'}
            >
              {isPaused ? <Play className="w-3 h-3 fill-current" /> : <Pause className="w-3 h-3 fill-current" />}
              {isPaused ? '已暫停' : '輪播中'}
            </button>
            
            <div className="flex items-center gap-1.5 bg-[#14151a] border border-[#2b3139] rounded px-1.5 py-0.5">
              <button 
                onClick={handlePrevPage}
                className="p-1 hover:bg-[#2b3139] text-gray-400 hover:text-white rounded transition-colors"
              >
                <ChevronLeft className="w-3 h-3" />
              </button>
              <div className="text-[10px] text-gray-500 font-mono w-16 text-center">
                <span className="text-[#f0b90b] font-bold">{currentPage + 1}</span> / {totalPages}
              </div>
              <button 
                onClick={handleNextPage}
                className="p-1 hover:bg-[#2b3139] text-gray-400 hover:text-white rounded transition-colors"
              >
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

        {marketMonitoring.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            {marketMonitoring
              .slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE)
              .map(d => (
                <DetailedCard key={d.symbol} data={d} />
              ))}
          </div>
        ) : (
          <div className="bg-[#14151a] border border-[#2b3139] rounded-lg py-8 text-center text-xs text-gray-400">
            實時數據排隊安全拉取中...
          </div>
        )}
      </section>
    </div>
  );
}