// Mock data for cars, tracks, users, players, logs
// Cars use SVG silhouettes (simple monochrome) as placeholders for the
// "real" thumbnails that would live in the Assetto Corsa mod folders.

const SILHOUETTES = [
  // GT3-ish low coupe
  (c1, c2) => `<svg viewBox='0 0 220 138' xmlns='http://www.w3.org/2000/svg'>
    <defs><linearGradient id='g1' x1='0' x2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>
    <rect width='220' height='138' fill='url(#g1)'/>
    <g fill='none' stroke='rgba(255,255,255,0.18)' stroke-width='1'>
      ${Array.from({length:8}).map((_,i)=>`<line x1='${i*30}' y1='0' x2='${i*30+40}' y2='138'/>`).join('')}
    </g>
    <g fill='#1a1a1d' stroke='#000' stroke-width='1'>
      <path d='M30 92 L46 70 Q60 56 88 54 L132 54 Q160 56 174 70 L190 92 L190 102 L30 102 Z'/>
      <rect x='62' y='62' width='90' height='14' rx='2' fill='#3a3a40'/>
    </g>
    <circle cx='62' cy='102' r='14' fill='#0a0a0c' stroke='#3a3a40'/>
    <circle cx='158' cy='102' r='14' fill='#0a0a0c' stroke='#3a3a40'/>
    <circle cx='62' cy='102' r='6' fill='#222'/>
    <circle cx='158' cy='102' r='6' fill='#222'/>
  </svg>`,
  // Open-wheel formula
  (c1, c2) => `<svg viewBox='0 0 220 138' xmlns='http://www.w3.org/2000/svg'>
    <defs><linearGradient id='g2' x1='0' x2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>
    <rect width='220' height='138' fill='url(#g2)'/>
    <g fill='#1a1a1d'>
      <rect x='40' y='90' width='140' height='10' rx='2'/>
      <path d='M85 90 L100 70 L130 70 L140 90 Z'/>
      <rect x='106' y='62' width='14' height='10' rx='2' fill='#3a3a40'/>
      <path d='M30 84 L40 90 L40 96 L30 96 Z'/>
      <path d='M180 84 L190 90 L190 96 L180 96 Z'/>
    </g>
    <circle cx='62' cy='100' r='16' fill='#0a0a0c' stroke='#3a3a40'/>
    <circle cx='158' cy='100' r='16' fill='#0a0a0c' stroke='#3a3a40'/>
  </svg>`,
  // Hatchback
  (c1, c2) => `<svg viewBox='0 0 220 138' xmlns='http://www.w3.org/2000/svg'>
    <defs><linearGradient id='g3' x1='0' x2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>
    <rect width='220' height='138' fill='url(#g3)'/>
    <g fill='#1a1a1d' stroke='#000'>
      <path d='M34 96 L42 80 Q54 60 86 56 L150 56 Q176 58 184 78 L188 96 L188 104 L34 104 Z'/>
      <rect x='66' y='66' width='80' height='14' rx='2' fill='#3a3a40'/>
    </g>
    <circle cx='66' cy='104' r='13' fill='#0a0a0c' stroke='#3a3a40'/>
    <circle cx='154' cy='104' r='13' fill='#0a0a0c' stroke='#3a3a40'/>
  </svg>`,
  // Classic / sedan
  (c1, c2) => `<svg viewBox='0 0 220 138' xmlns='http://www.w3.org/2000/svg'>
    <defs><linearGradient id='g4' x1='0' x2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>
    <rect width='220' height='138' fill='url(#g4)'/>
    <g fill='#1a1a1d' stroke='#000'>
      <path d='M28 94 L36 80 Q50 64 82 60 L138 60 Q170 64 184 80 L192 94 L192 102 L28 102 Z'/>
      <rect x='58' y='68' width='100' height='14' rx='1' fill='#3a3a40'/>
    </g>
    <circle cx='60' cy='102' r='13' fill='#0a0a0c' stroke='#3a3a40'/>
    <circle cx='160' cy='102' r='13' fill='#0a0a0c' stroke='#3a3a40'/>
  </svg>`,
  // Rally
  (c1, c2) => `<svg viewBox='0 0 220 138' xmlns='http://www.w3.org/2000/svg'>
    <defs><linearGradient id='g5' x1='0' x2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>
    <rect width='220' height='138' fill='url(#g5)'/>
    <g fill='#1a1a1d' stroke='#000'>
      <path d='M32 92 L40 72 Q54 58 86 56 L142 56 Q170 58 182 74 L190 92 L190 102 L32 102 Z'/>
      <rect x='60' y='62' width='96' height='16' rx='2' fill='#3a3a40'/>
      <rect x='100' y='44' width='14' height='14' fill='#dc2626'/>
    </g>
    <circle cx='64' cy='102' r='15' fill='#0a0a0c' stroke='#3a3a40'/>
    <circle cx='156' cy='102' r='15' fill='#0a0a0c' stroke='#3a3a40'/>
  </svg>`,
];

const carPalette = [
  ['#3a3a40', '#52525b'],
  ['#dc2626', '#7f1d1d'],
  ['#1e3a8a', '#0c1e4a'],
  ['#065f46', '#022c1f'],
  ['#a16207', '#451a03'],
  ['#374151', '#1f2937'],
  ['#7c2d12', '#3a1206'],
  ['#0e7490', '#083344'],
];

const CARS = [
  { id: 'ks_porsche_911_gt3_r_2016', name: '911 GT3 R 2016', brand: 'Porsche', cls: 'GT3', power: 500, weight: 1235, year: 2016, type: 0, p: 0 },
  { id: 'ks_ferrari_488_gt3', name: '488 GT3', brand: 'Ferrari', cls: 'GT3', power: 600, weight: 1260, year: 2016, type: 0, p: 1 },
  { id: 'ks_lamborghini_huracan_gt3', name: 'Huracán GT3', brand: 'Lamborghini', cls: 'GT3', power: 560, weight: 1239, year: 2015, type: 0, p: 2 },
  { id: 'ks_mclaren_650_gt3', name: '650S GT3', brand: 'McLaren', cls: 'GT3', power: 478, weight: 1294, year: 2015, type: 0, p: 3 },
  { id: 'ks_audi_r8_lms_2016', name: 'R8 LMS 2016', brand: 'Audi', cls: 'GT3', power: 535, weight: 1235, year: 2016, type: 0, p: 4 },
  { id: 'ks_bmw_m4_akrapovic', name: 'M4 Akrapovic', brand: 'BMW', cls: 'Sport', power: 431, weight: 1497, year: 2016, type: 0, p: 5 },

  { id: 'rss_formula_hybrid_2022', name: 'Formula Hybrid 2022', brand: 'RSS', cls: 'F1', power: 1000, weight: 798, year: 2022, type: 1, p: 1 },
  { id: 'ks_lotus_98t', name: 'Lotus 98T', brand: 'Lotus', cls: 'F1', power: 950, weight: 540, year: 1986, type: 1, p: 6 },
  { id: 'rss_formula_rss_3_v6', name: 'Formula RSS 3 V6', brand: 'RSS', cls: 'F3', power: 380, weight: 660, year: 2020, type: 1, p: 2 },

  { id: 'ks_mazda_mx5_nd', name: 'MX-5 ND', brand: 'Mazda', cls: 'Street', power: 158, weight: 1060, year: 2015, type: 2, p: 0 },
  { id: 'ks_toyota_gt86', name: 'GT86', brand: 'Toyota', cls: 'Street', power: 197, weight: 1240, year: 2012, type: 2, p: 7 },
  { id: 'ks_abarth500_assetto_corse', name: 'Abarth 500 AC', brand: 'Abarth', cls: 'Street', power: 190, weight: 1050, year: 2010, type: 2, p: 1 },
  { id: 'ks_alfa_giulia_qv', name: 'Giulia QV', brand: 'Alfa Romeo', cls: 'Street', power: 510, weight: 1525, year: 2016, type: 3, p: 1 },

  { id: 'ks_ferrari_250_gto', name: '250 GTO', brand: 'Ferrari', cls: 'Vintage', power: 296, weight: 880, year: 1962, type: 3, p: 1 },
  { id: 'ks_porsche_911_carrera_rsr', name: '911 Carrera RSR', brand: 'Porsche', cls: 'Vintage', power: 300, weight: 900, year: 1974, type: 3, p: 0 },
  { id: 'ks_lancia_037_stradale', name: 'Lancia 037', brand: 'Lancia', cls: 'Rally', power: 205, weight: 1170, year: 1982, type: 4, p: 6 },
  { id: 'ks_subaru_impreza_22b', name: 'Impreza 22B', brand: 'Subaru', cls: 'Rally', power: 280, weight: 1270, year: 1998, type: 4, p: 2 },
];

const CARS_WITH_THUMB = CARS.map(c => {
  const [a, b] = carPalette[c.p];
  const svg = SILHOUETTES[c.type](a, b);
  return { ...c, thumb: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) };
});

const TRACK_SVG = (color, layoutPath) => `<svg viewBox='0 0 320 180' xmlns='http://www.w3.org/2000/svg'>
  <defs>
    <linearGradient id='tg' x1='0' x2='0' y1='0' y2='1'>
      <stop offset='0' stop-color='${color}' stop-opacity='0.8'/>
      <stop offset='1' stop-color='${color}' stop-opacity='0.3'/>
    </linearGradient>
  </defs>
  <rect width='320' height='180' fill='url(#tg)'/>
  <g stroke='rgba(255,255,255,0.08)' stroke-width='1'>
    ${Array.from({length:10}).map((_,i)=>`<line x1='0' y1='${i*20}' x2='320' y2='${i*20}'/>`).join('')}
    ${Array.from({length:18}).map((_,i)=>`<line x1='${i*20}' y1='0' x2='${i*20}' y2='180'/>`).join('')}
  </g>
  <path d='${layoutPath}' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round' opacity='0.95'/>
  <path d='${layoutPath}' fill='none' stroke='white' stroke-width='1' stroke-dasharray='2 4' opacity='0.5'/>
</svg>`;

const TRACKS = [
  { id: 'ks_nordschleife', name: 'Nürburgring Nordschleife', loc: 'Germany', length: 20.832, layouts: ['Nordschleife', 'Tourist', 'Sprint'], pits: 24, color: '#16a34a',
    path: 'M40 80 Q60 40 100 50 T180 60 Q240 70 260 110 Q280 150 220 160 Q160 165 110 145 Q60 130 40 80 Z' },
  { id: 'ks_spa', name: 'Spa-Francorchamps', loc: 'Belgium', length: 7.004, layouts: ['Grand Prix', '2020'], pits: 32, color: '#dc2626',
    path: 'M30 90 L80 60 Q120 50 140 80 L180 60 Q220 50 250 90 Q280 130 240 150 Q180 160 130 140 Q80 130 50 130 Q30 120 30 90 Z' },
  { id: 'ks_monza', name: 'Monza', loc: 'Italy', length: 5.793, layouts: ['Grand Prix', 'Junior', '10s'], pits: 36, color: '#1e3a8a',
    path: 'M50 60 L260 60 Q280 70 270 100 L230 130 Q200 150 160 140 L100 140 Q60 130 50 100 Z' },
  { id: 'ks_silverstone', name: 'Silverstone', loc: 'United Kingdom', length: 5.891, layouts: ['GP', 'International', 'National'], pits: 28, color: '#0e7490',
    path: 'M40 70 Q80 50 130 60 L200 50 Q260 60 280 100 Q270 140 220 145 L150 140 Q90 145 60 120 Q30 100 40 70 Z' },
  { id: 'ks_imola', name: 'Imola', loc: 'Italy', length: 4.909, layouts: ['Grand Prix'], pits: 30, color: '#a16207',
    path: 'M50 80 Q70 50 110 55 L180 60 Q230 65 260 95 Q270 130 230 145 L150 150 Q90 145 60 125 Q40 105 50 80 Z' },
  { id: 'ks_brands_hatch', name: 'Brands Hatch', loc: 'United Kingdom', length: 3.916, layouts: ['Grand Prix', 'Indy'], pits: 22, color: '#7c2d12',
    path: 'M60 70 Q90 50 140 60 Q200 50 240 80 Q280 110 240 140 Q180 150 130 135 Q80 130 50 110 Q40 90 60 70 Z' },
  { id: 'ks_zandvoort', name: 'Zandvoort', loc: 'Netherlands', length: 4.259, layouts: ['Grand Prix', 'Club'], pits: 24, color: '#0d9488',
    path: 'M40 100 L80 60 Q140 50 180 80 L240 60 Q270 80 260 110 Q220 145 170 140 L120 145 Q70 140 40 100 Z' },
  { id: 'ks_red_bull_ring', name: 'Red Bull Ring', loc: 'Austria', length: 4.318, layouts: ['Grand Prix'], pits: 26, color: '#374151',
    path: 'M50 130 L80 70 L150 60 L200 90 L250 70 Q280 100 260 130 Q200 150 150 140 L100 140 Q60 140 50 130 Z' },
];

const TRACKS_WITH_THUMB = TRACKS.map(t => ({ ...t, thumb: 'data:image/svg+xml;utf8,' + encodeURIComponent(TRACK_SVG(t.color, t.path)) }));

const PLAYERS_LIVE = [
  { id: 1, name: 'Mattia.B', steam: '76561198000000012', car: 'Porsche 911 GT3 R 2016', laps: 14, best: '1:55.342', last: '1:56.018', ping: 28 },
  { id: 2, name: 'JoeRacer', steam: '76561198000000018', car: 'Ferrari 488 GT3', laps: 14, best: '1:55.501', last: '1:55.987', ping: 41 },
  { id: 3, name: 'Aitor_RC', steam: '76561198000000010', car: 'Audi R8 LMS 2016', laps: 13, best: '1:56.014', last: '1:56.219', ping: 19 },
  { id: 4, name: 'Klaus_DRS', steam: '76561198000000015', car: 'BMW M4 Akrapovic', laps: 13, best: '1:56.401', last: '1:57.019', ping: 36 },
  { id: 5, name: 'Hiro_88', steam: '76561198000000020', car: 'McLaren 650S GT3', laps: 12, best: '1:57.012', last: '1:58.002', ping: 84 },
  { id: 6, name: 'Marquez33', steam: '76561198000000016', car: 'Lamborghini Huracán GT3', laps: 12, best: '1:57.305', last: '1:57.880', ping: 22 },
];

const USERS_INITIAL = [
  { id: 1, name: 'admin', email: 'admin@example.com', role: 'admin', created: '2025-08-04', active: true },
  { id: 2, name: 'mattia', email: 'driver-c@example.com', role: 'admin', created: '2025-09-12', active: true },
  { id: 3, name: 'jorge_p', email: 'driver-a@example.com', role: 'user', created: '2025-10-21', active: true },
  { id: 4, name: 'lucia.r', email: 'driver-b@example.com', role: 'user', created: '2026-01-15', active: true },
  { id: 5, name: 'spectator', email: 'guest@example.com', role: 'user', created: '2026-02-08', active: false },
];

const LOG_TEMPLATES = [
  { lvl: 'info', tag: 'CORE', msg: 'Tick rate stable at 18ms' },
  { lvl: 'info', tag: 'NET', msg: 'Heartbeat sent to lobby.assettocorsa.net' },
  { lvl: 'ok', tag: 'SESSION', msg: 'Lap completed by Mattia.B — 1:55.342' },
  { lvl: 'info', tag: 'NET', msg: 'Player JoeRacer entered pit lane' },
  { lvl: 'warn', tag: 'PLUGIN', msg: 'KissMyRank: late ack from client #4' },
  { lvl: 'info', tag: 'CORE', msg: 'Auto-save persistence.json' },
  { lvl: 'ok', tag: 'AUTH', msg: 'Steam session validated for Hiro_88' },
  { lvl: 'info', tag: 'WEATHER', msg: 'Track temperature: 28°C, ambient: 22°C' },
  { lvl: 'warn', tag: 'NET', msg: 'High ping detected for Hiro_88 (84ms)' },
  { lvl: 'info', tag: 'SESSION', msg: 'Practice session: 8m remaining' },
  { lvl: 'ok', tag: 'SESSION', msg: 'Best sector by Marquez33: S2 32.401' },
  { lvl: 'info', tag: 'CORE', msg: 'Garbage collection: 14ms' },
];

const PLAYERS_PAST = [
  { id: 101, name: 'Diego_RT', steam: '76561198000000011', car: 'Ferrari 488 GT3', lastSeen: '2026-04-30 22:14', laps: 28, totalTime: '52m', sessions: 14 },
  { id: 102, name: 'Kenji.S', steam: '76561198000000021', car: 'McLaren 650S GT3', lastSeen: '2026-04-30 21:02', laps: 19, totalTime: '38m', sessions: 8 },
  { id: 103, name: 'Sofia_M', steam: '76561198000000014', car: 'Audi R8 LMS 2016', lastSeen: '2026-04-29 23:45', laps: 32, totalTime: '1h 03m', sessions: 11 },
  { id: 104, name: 'Pablo_GT', steam: '76561198000000019', car: 'Lamborghini Huracán GT3', lastSeen: '2026-04-29 20:18', laps: 22, totalTime: '44m', sessions: 6 },
  { id: 105, name: 'NoobMaster', steam: '76561198000000017', car: 'Porsche 911 GT3 R 2016', lastSeen: '2026-04-28 19:30', laps: 5, totalTime: '12m', sessions: 2 },
  { id: 106, name: 'Vero_F', steam: '76561198000000022', car: 'BMW M4 Akrapovic', lastSeen: '2026-04-27 22:52', laps: 41, totalTime: '1h 18m', sessions: 19 },
  { id: 107, name: 'TheStig', steam: '76561198000000013', car: 'Ferrari 488 GT3', lastSeen: '2026-04-25 21:10', laps: 56, totalTime: '1h 49m', sessions: 24 },
];

// Lap time records — used by the Tiempos page
// player, car, track, layout, time (ms), date, sector1, sector2, sector3, valid
const LAP_TIMES = (() => {
  const players = ['Mattia.B', 'JoeRacer', 'Aitor_RC', 'Klaus_DRS', 'Hiro_88', 'Marquez33', 'Diego_RT', 'Kenji.S', 'Sofia_M', 'Pablo_GT', 'Vero_F', 'TheStig'];
  const carIds = ['ks_porsche_911_gt3_r_2016', 'ks_ferrari_488_gt3', 'ks_lamborghini_huracan_gt3', 'ks_audi_r8_lms_2016', 'ks_mclaren_650_gt3', 'ks_bmw_m4_akrapovic'];
  const trackIds = ['ks_spa', 'ks_monza', 'ks_silverstone', 'ks_imola', 'ks_brands_hatch', 'ks_zandvoort', 'ks_red_bull_ring', 'ks_nordschleife'];
  // base lap time per track in seconds — gives a realistic distribution
  const baseTimes = {
    ks_spa: 116, ks_monza: 105, ks_silverstone: 119, ks_imola: 96,
    ks_brands_hatch: 84, ks_zandvoort: 90, ks_red_bull_ring: 91, ks_nordschleife: 412,
  };
  const out = [];
  let id = 1;
  // seeded pseudo-random for reproducibility
  let seed = 42;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

  for (const p of players) {
    const skill = 1 + rnd() * 0.04; // 1.00 — 1.04 (lower = faster)
    for (const t of trackIds) {
      const base = baseTimes[t];
      const numLaps = 1 + Math.floor(rnd() * 3);
      // Some players don't have records on all tracks
      if (rnd() < 0.2) continue;
      for (let i = 0; i < numLaps; i++) {
        const car = carIds[Math.floor(rnd() * carIds.length)];
        const variance = (rnd() - 0.5) * (base * 0.04);
        const totalSec = base * skill + variance + i * (rnd() - 0.6) * 0.4;
        const ms = Math.round(totalSec * 1000);
        const s1 = Math.round(ms * (0.30 + (rnd() - 0.5) * 0.04));
        const s2 = Math.round(ms * (0.36 + (rnd() - 0.5) * 0.04));
        const s3 = ms - s1 - s2;
        const day = 14 + Math.floor(rnd() * 16);
        const valid = rnd() > 0.08;
        out.push({
          id: id++, player: p, car, track: t,
          layout: 'Grand Prix',
          ms, s1, s2, s3,
          date: `2026-04-${String(day).padStart(2,'0')}`,
          valid,
        });
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.ms - b.ms);
})();

window.AppData = {
  CARS: CARS_WITH_THUMB,
  TRACKS: TRACKS_WITH_THUMB,
  PLAYERS_LIVE,
  PLAYERS_PAST,
  USERS_INITIAL,
  LOG_TEMPLATES,
  LAP_TIMES,
};

// Shared utilities used across page files
window.AppUtils = {
  fmtMs: (ms) => {
    if (ms == null || ms < 0) return '—';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const t = ms % 1000;
    return `${m}:${String(s).padStart(2,'0')}.${String(t).padStart(3,'0')}`;
  },
};
