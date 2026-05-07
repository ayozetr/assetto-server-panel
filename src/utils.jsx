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
};
