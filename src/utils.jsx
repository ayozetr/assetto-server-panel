// Shared utilities used across page files

const _NATION_ISO2 = {
  AFG:'af',ALB:'al',ALG:'dz',AND:'ad',ANG:'ao',ARG:'ar',ARM:'am',AUS:'au',AUT:'at',AZE:'az',
  BEL:'be',BGR:'bg',BIH:'ba',BLR:'by',BOL:'bo',BRA:'br',BUL:'bg',CAN:'ca',CHE:'ch',CHI:'cl',
  CHN:'cn',COL:'co',CRO:'hr',CYP:'cy',CZE:'cz',DEN:'dk',DNK:'dk',ECU:'ec',EGY:'eg',ESP:'es',
  EST:'ee',ETH:'et',FIN:'fi',FRA:'fr',GBR:'gb',GEO:'ge',GER:'de',DEU:'de',GRE:'gr',GRC:'gr',
  HKG:'hk',HRV:'hr',HUN:'hu',IND:'in',IRL:'ie',IRN:'ir',ISL:'is',ISR:'il',ITA:'it',JPN:'jp',
  KAZ:'kz',KOR:'kr',LAT:'lv',LTU:'lt',LUX:'lu',MAR:'ma',MEX:'mx',MKD:'mk',MNE:'me',MON:'mc',
  NED:'nl',NLD:'nl',NOR:'no',NZL:'nz',PER:'pe',POL:'pl',POR:'pt',PRT:'pt',ROM:'ro',ROU:'ro',
  RSA:'za',ZAF:'za',RUS:'ru',SCO:'gb',SER:'rs',SRB:'rs',SLO:'si',SVN:'si',SVK:'sk',SPA:'es',
  SUI:'ch',SWE:'se',THA:'th',TUN:'tn',TUR:'tr',UAE:'ae',UKR:'ua',URU:'uy',USA:'us',VEN:'ve',
  WAL:'gb',
};

// Mirrors server-side passwordPolicyError(): ≥12 chars OR ≥8 with three of
// {lowercase, UPPERCASE, digit, symbol}. Server is authoritative — this is for
// instant client feedback only.
function passesPwPolicy(pw) {
  if (typeof pw !== 'string' || pw.length > 128) return false;
  if (pw.length >= 12) return true;
  if (pw.length < 8) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(rx => rx.test(pw)).length;
  return classes >= 3;
}
window.passesPwPolicy = passesPwPolicy;

// Longest character-by-character common prefix across an array of strings.
// Used to recover a base track name when each layout's name redundantly
// includes the track root (e.g. "Red Bull Ring", "Red Bull Ring Real
// Outbound", …) — common prefix → "Red Bull Ring ".
function _longestCommonPrefix(arr) {
  if (!arr || !arr.length) return '';
  let p = arr[0];
  for (let i = 1; i < arr.length; i++) {
    let j = 0;
    while (j < p.length && j < arr[i].length && p[j] === arr[i][j]) j++;
    p = p.slice(0, j);
    if (!p) break;
  }
  return p;
}

// Returns the base track name with the redundant layout suffix stripped when
// the catalogue has no root ui_track.json. Falls back to track.name.
function trackBaseName(track) {
  if (!track) return '';
  const names = track.layoutDetails ? Object.values(track.layoutDetails).map(d => d && d.name).filter(Boolean) : [];
  if (names.length < 2) return track.name || '';
  const common = _longestCommonPrefix(names).replace(/[\s_/-]+$/, '');
  return common.length >= 3 ? common : (track.name || '');
}

// Returns the layout's display name with the shared track prefix stripped
// when present, so it reads as just the variant (e.g. "Grand Prix" instead
// of "Red Bull Ring"). Falls back to the raw layout name.
function layoutShortName(track, layoutId) {
  if (!track) return layoutId || '';
  const raw = (track.layoutDetails && track.layoutDetails[layoutId] && track.layoutDetails[layoutId].name) || layoutId || '';
  const base = trackBaseName(track);
  if (!base || !raw) return raw;
  if (raw.toLowerCase().startsWith(base.toLowerCase())) {
    return raw.slice(base.length).replace(/^[\s_/-]+/, '').trim() || raw;
  }
  return raw;
}

window.AppUtils = {
  fmtMs: (ms) => {
    if (ms == null || ms < 0) return '—';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const t = ms % 1000;
    return `${m}:${String(s).padStart(2,'0')}.${String(t).padStart(3,'0')}`;
  },
  nationFlag: (nation3) => {
    if (!nation3) return null;
    const iso2 = _NATION_ISO2[nation3.toUpperCase()];
    return iso2 ? `https://flagcdn.com/16x12/${iso2}.png` : null;
  },
  passesPwPolicy,
  trackBaseName,
  layoutShortName,
};
