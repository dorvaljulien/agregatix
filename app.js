'use strict';
/* Agrégatix — moteur. Aucune dépendance hormis KaTeX (vendor/). */

const CLE = 'agregatix.v1';
const TAILLE_SESSION = 10;
const INTERVALLES = [0, 1, 3, 7, 16, 35];          // jours avant de revoir, par boîte
const BOITE_MAX = INTERVALLES.length - 1;
const MODES = { vf: 'Vrai ou faux ?', qcm: 'Le bon énoncé', erreur: "Traque à l'erreur", piste: 'Par où partir ?', cours: 'Rappel de cours' };
const FREQ = { 3: 'Très fréquent', 2: 'Régulier', 1: 'Occasionnel' };   // présence du chapitre aux écrits (index.json, champ poids)
const TIRAGE = { 3: 4, 2: 2, 1: 1 };                // chances relatives d'une carte neuve en session du jour
const MEMOIRE = 8;                                  // dernières réponses retenues par chapitre
const ECHECS_ALERTE = 3;                            // échecs parmi elles à partir desquels les rappels de cours passent devant
const RAPPELS_MAX = 3;                              // rappels prioritaires par session
const TITRES = ['Bizuth', 'Candidat', 'Préparationnaire', 'Admissible', 'Admis', 'Agrégé', 'Major'];
/* Maîtrise (0-1) à atteindre pour chaque titre : le niveau suit ce que tu sais vraiment, pas le temps passé. */
const SEUILS = [0, 0.05, 0.15, 0.35, 0.55, 0.75, 0.90];
const CLE_SESSION = 'agregatix.session.v1';

const $app = document.getElementById('app');
const $voile = document.getElementById('voile');
const $feuille = document.getElementById('feuille');

let programme = null;          // data/index.json
let cartes = [];               // toutes les cartes
let parChapitre = {};          // id chapitre -> cartes
let chapitres = {};            // id chapitre -> chapitre (avec couleur du domaine)
let etat = charger();
let session = null;

/* ---------- Utilitaires ---------- */
const aujourdhui = () => { const d = new Date(); return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000); };
const echapper = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const melanger = t => { const a = t.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const vibrer = motif => { try { navigator.vibrate && navigator.vibrate(motif); } catch (e) { /* sans vibreur */ } };

/* Texte de carte -> HTML : $...$ et $$...$$ rendus par KaTeX, **gras**, retours à la ligne. */
/* Code : ```bloc``` (police fixe, indentation conservée) et `en ligne`. Ni LaTeX ni gras à l'intérieur. */
const CODE = /(```\n?[\s\S]+?```|`[^`\n]+`)/g;
function fmt(texte) {
  return String(texte).split(CODE).map(bout => {
    if (bout.startsWith('```')) return `<pre class="code">${echapper(bout.slice(3, -3).replace(/^\n|\n$/g, ''))}</pre>`;
    if (bout.startsWith('`') && bout.length > 2) return `<code>${echapper(bout.slice(1, -1))}</code>`;
    return fmtTexte(bout);
  }).join('');
}
function fmtTexte(texte) {
  return texte.split(/(\$\$[\s\S]+?\$\$|\$[^$]+?\$)/g).map(bout => {
    const bloc = bout.startsWith('$$');
    if (bout.startsWith('$') && bout.length > 2) {
      const tex = bloc ? bout.slice(2, -2) : bout.slice(1, -1);
      try { return katex.renderToString(tex, { displayMode: bloc, throwOnError: false }); }
      catch (e) { return echapper(bout); }
    }
    return echapper(bout).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  }).join('');
}

/* ---------- Figures ----------
   Une carte peut porter un champ "figure" : { x: [min, max], y: [min, max], el: [...] }, dessiné en SVG dans un repère
   orthonormé (ou de hauteur h × largeur si "h" est donné). Le format des éléments est décrit dans tools/GUIDE_CARTES.md. */
let numFigure = 0;
const expr = (e, v) => new Function(v, 'with (Math) { return (' + e + '); }');
function figure(f) {
  const L = 300, [x0, x1] = f.x, [y0, y1] = f.y;
  const H = Math.round(L * (f.h || (y1 - y0) / (x1 - x0)));
  const X = x => (x - x0) / (x1 - x0) * L, Y = y => H - (y - y0) / (y1 - y0) * H;
  const n = v => Math.round(v * 10) / 10;
  const P = p => `${n(X(p[0]))},${n(Y(p[1]))}`;
  const marge = 3 * (y1 - y0);
  const trace = pts => {                               // ligne brisée, coupée là où la courbe sort franchement du cadre
    let d = '', leve = true;
    for (const p of pts) {
      if (!isFinite(p[0]) || !isFinite(p[1]) || p[1] > y1 + marge || p[1] < y0 - marge) { leve = true; continue; }
      d += (leve ? 'M' : 'L') + P(p); leve = false;
    }
    return d;
  };
  const pas = (de, a, g) => Array.from({ length: 241 }, (_, i) => g(de + (a - de) * i / 240));
  const cls = (e, base) => `class="${base} c-${e.c || 'a'}${e.tirets ? ' tirets' : ''}"`;
  const ancre = { n: [0, -8, 'middle'], s: [0, 16, 'middle'], e: [8, 4, 'start'], o: [-8, 4, 'end'],
    ne: [6, -6, 'start'], no: [-6, -6, 'end'], se: [6, 14, 'start'], so: [-6, 14, 'end'] };
  const texte = (p, s, pos) => { const [dx, dy, a] = ancre[pos || 'ne']; return `<text x="${n(X(p[0]) + dx)}" y="${n(Y(p[1]) + dy)}" text-anchor="${a}">${echapper(String(s))}</text>`; };
  let fond = '', devant = '';
  if (f.axes !== false) {
    const axeX = y0 < 0 && y1 > 0, axeY = x0 < 0 && x1 > 0;
    if (axeX) fond += `<path class="axe" d="M0,${n(Y(0))}H${L}"/><path class="pointe" d="M${L},${n(Y(0))}l-7,-3.5v7z"/>`;
    if (axeY) fond += `<path class="axe" d="M${n(X(0))},${H}V0"/><path class="pointe" d="M${n(X(0))},0l-3.5,7h7z"/>`;
    if (x1 - x0 <= 14 && y1 - y0 <= 14) {
      for (let k = Math.ceil(x0); k <= x1; k++) if (k && axeX && X(k) < L - 8) fond += `<path class="axe" d="M${n(X(k))},${n(Y(0) - 3)}v6"/>`;
      for (let k = Math.ceil(y0); k <= y1; k++) if (k && axeY && Y(k) > 8) fond += `<path class="axe" d="M${n(X(0) - 3)},${n(Y(k))}h6"/>`;
      if (f.unites !== false && axeX && axeY && x1 > 1 && y1 > 1) fond += `<text class="unite" x="${n(X(1))}" y="${n(Y(0) + 14)}" text-anchor="middle">1</text><text class="unite" x="${n(X(0) - 6)}" y="${n(Y(1) + 4)}" text-anchor="end">1</text>`;
    }
  }
  for (const e of f.el || []) {
    if (e.t === 'f') { const g = expr(e.e, 'x'); fond += `<path ${cls(e, 'trait')} d="${trace(pas(e.de ?? x0, e.a ?? x1, x => [x, g(x)]))}"/>`; }
    else if (e.t === 'param') { const gx = expr(e.x, 't'), gy = expr(e.y, 't'); fond += `<path ${cls(e, 'trait')} d="${trace(pas(e.de, e.a, t => [gx(t), gy(t)]))}"/>`; }
    else if (e.t === 'polaire') { const g = expr(e.r, 't'); fond += `<path ${cls(e, 'trait')} d="${trace(pas(e.de, e.a, t => [g(t) * Math.cos(t), g(t) * Math.sin(t)]))}"/>`; }
    else if (e.t === 'zone') {
      const haut = expr(e.e, 'x'), bas = expr(e.e2 || '0', 'x'), de = e.de ?? x0, a = e.a ?? x1;
      const bord = pas(de, a, x => [x, haut(x)]).concat(pas(a, de, x => [x, bas(x)]));
      fond += `<polygon ${cls(e, 'zone')} points="${bord.map(P).join(' ')}"/>`;
    }
    else if (e.t === 'poly') fond += `<polygon ${cls(e, e.plein ? 'zone bord' : 'trait')} points="${e.pts.map(P).join(' ')}"/>`;
    else if (e.t === 'cercle') fond += `<ellipse ${cls(e, e.plein ? 'zone bord' : 'trait')} cx="${n(X(e.o[0]))}" cy="${n(Y(e.o[1]))}" rx="${n(e.r * L / (x1 - x0))}" ry="${n(e.r * H / (y1 - y0))}"/>`;
    else if (e.t === 'seg' || e.t === 'droite') {
      let a = e.a, b = e.b;
      if (e.t === 'droite') { const k = 50 * (x1 - x0 + y1 - y0) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1), u = [(b[0] - a[0]) * k, (b[1] - a[1]) * k]; b = [a[0] + u[0], a[1] + u[1]]; a = [a[0] - u[0], a[1] - u[1]]; }
      fond += `<path ${cls(e, 'trait')} d="M${P(a)}L${P(b)}"/>`;
      if (e.fleche) {
        const ax = X(a[0]), ay = Y(a[1]), bx = X(b[0]), by = Y(b[1]), l = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / l, uy = (by - ay) / l;
        fond += `<polygon ${cls(e, 'plein')} points="${n(bx)},${n(by)} ${n(bx - 9 * ux + 4 * uy)},${n(by - 9 * uy - 4 * ux)} ${n(bx - 9 * ux - 4 * uy)},${n(by - 9 * uy + 4 * ux)}"/>`;
      }
    }
    else if (e.t === 'pt') devant += `<circle ${cls(e, 'plein')} cx="${n(X(e.p[0]))}" cy="${n(Y(e.p[1]))}" r="3.2"/>` + (e.n ? texte(e.p, e.n, e.pos) : '');
    else if (e.t === 'txt') devant += texte(e.p, e.s, e.pos || 'n');
  }
  const id = 'cadre' + (++numFigure);
  return `<figure class="figure"><svg viewBox="0 0 ${L} ${H}" role="img" aria-label="${echapper(f.legende || 'Figure')}">
    <clipPath id="${id}"><rect width="${L}" height="${H}"/></clipPath><g clip-path="url(#${id})">${fond}${devant}</g></svg>
    ${f.legende ? `<figcaption>${fmt(f.legende)}</figcaption>` : ''}</figure>`;
}

/* ---------- Sauvegarde ---------- */
function charger() {
  const vide = { xp: 0, serie: 0, dernierJour: null, cartes: {}, signalements: [], chap: {}, tri: 'programme' };
  try { return Object.assign(vide, JSON.parse(localStorage.getItem(CLE)) || {}); }
  catch (e) { return vide; }
}
function sauver() { try { localStorage.setItem(CLE, JSON.stringify(etat)); } catch (e) { /* stockage indisponible */ } }

/* Session en cours : gardée à part pour qu'on la retrouve si l'appli est rechargée ou fermée par le système. */
function sauverSession() {
  try {
    if (!session) { localStorage.removeItem(CLE_SESSION); return; }
    const v = session.vue;
    localStorage.setItem(CLE_SESSION, JSON.stringify({
      file: session.file.map(c => c.id), i: session.i, total: session.total, faits: session.faits, bons: session.bons,
      xp: session.xp, combo: session.combo, libre: session.libre, revues: [...session.revues], rappels: [...session.rappels], echecs: session.echecs,
      vue: v && { id: v.carte.id, repondu: v.repondu, choisi: v.choisi, ordre: v.ordre, revue: v.revue, verdict: v.verdict }
    }));
  } catch (e) { /* stockage indisponible */ }
}
function reprendreSession() {
  try {
    const o = JSON.parse(localStorage.getItem(CLE_SESSION));
    if (!o || !o.vue) return false;
    const parId = Object.fromEntries(cartes.map(c => [c.id, c]));
    const file = o.file.map(id => parId[id]);
    if (file.some(c => !c) || !file[o.i] || file[o.i].id !== o.vue.id) return false;
    session = { file, i: o.i, total: o.total, faits: o.faits, bons: o.bons, xp: o.xp, combo: o.combo, libre: o.libre, revues: new Set(o.revues), vue: null, rappels: new Set(o.rappels || []), echecs: o.echecs || {} };
    session.vue = { carte: file[o.i], repondu: o.vue.repondu, choisi: o.vue.choisi, ordre: o.vue.ordre, revue: o.vue.revue, verdict: o.vue.verdict };
    dessiner();
    return true;
  } catch (e) { session = null; return false; }
}

/* ---------- Progression ---------- */
const suivi = id => etat.cartes[id];
const estDue = c => { const s = suivi(c.id); return s && s.d <= aujourdhui(); };
const estNeuve = c => !suivi(c.id);
function maitrise(liste) {
  if (!liste.length) return 0;
  return liste.reduce((t, c) => t + (suivi(c.id) ? suivi(c.id).b : 0), 0) / (BOITE_MAX * liste.length);
}
function niveau(m) {
  let n = 0;
  while (n + 1 < SEUILS.length && m >= SEUILS[n + 1]) n++;
  return { n: n + 1, titre: TITRES[n], bas: SEUILS[n], haut: n + 1 < SEUILS.length ? SEUILS[n + 1] : 1 };
}
function noter(carte, verdict) {
  const j = aujourdhui();
  const s = suivi(carte.id) || { b: 0, d: j, n: 0 };
  if (verdict === 'bon') s.b = Math.min(BOITE_MAX, s.b + 1);
  else if (verdict === 'faux') s.b = Math.max(0, Math.min(s.b - 2, 1));
  s.d = j + (verdict === 'bon' ? INTERVALLES[s.b] : 1);
  s.n++;
  s.v = j;                                          // dernier jour où la carte a été vue
  etat.cartes[carte.id] = s;
}
/* Mémoire courte par chapitre : 1 = réussi, 0 = raté. Les rappels de cours n'y comptent pas. */
function retenir(carte, verdict) {
  if (carte.type === 'cours') return;
  etat.chap[carte.ch] = (etat.chap[carte.ch] || []).concat(verdict === 'faux' ? 0 : 1).slice(-MEMOIRE);
}
const enDifficulte = ch => (etat.chap[ch] || []).filter(x => !x).length >= ECHECS_ALERTE;
const estCours = c => c.type === 'cours';
const vueAujourdhui = c => { const s = suivi(c.id); return s && s.v === aujourdhui(); };
const rang = c => suivi(c.id) ? suivi(c.id).b : -1;
/* Rappels de cours des chapitres où ça coince, pas déjà vus aujourd'hui : les moins bien sus d'abord. */
function rappelsPrioritaires(liste) {
  const parCh = {};
  for (const c of liste) if (estCours(c) && enDifficulte(c.ch) && !vueAujourdhui(c)) (parCh[c.ch] = parCh[c.ch] || []).push(c);
  const lots = Object.values(parCh).map(l => l.sort((a, b) => rang(a) - rang(b)).slice(0, 2));
  lots.sort((a, b) => (chapitres[b[0].ch].poids || 1) - (chapitres[a[0].ch].poids || 1));
  return lots.flat().slice(0, RAPPELS_MAX);
}
function marquerJour() {
  const j = aujourdhui();
  if (etat.dernierJour === j) return;
  etat.serie = etat.dernierJour === j - 1 ? etat.serie + 1 : 1;
  etat.dernierJour = j;
}

/* ---------- Construction d'une session ---------- */
function composer(liste, pondere) {
  const rappels = rappelsPrioritaires(liste);
  const reste = liste.filter(c => !rappels.includes(c));
  const place = TAILLE_SESSION - rappels.length;
  const dues = melanger(reste.filter(estDue)).sort((a, b) => suivi(a.id).d - suivi(b.id).d);
  // Session du jour : les cartes neuves des chapitres fréquents aux écrits sortent plus souvent.
  const cle = c => pondere ? Math.random() ** (1 / TIRAGE[chapitres[c.ch].poids || 1]) : Math.random();
  const neuves = reste.filter(estNeuve).map(c => [cle(c), c]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  let choix = dues.slice(0, place);
  choix = choix.concat(neuves.slice(0, place - choix.length));
  let libre = false;
  if (!choix.length && !rappels.length) { libre = true; choix = melanger(liste).slice(0, TAILLE_SESSION); }
  return { file: rappels.concat(melanger(choix)), libre, rappels: new Set(rappels.map(c => c.id)) };
}
function lancer(idChapitre, seulementCours) {
  const liste = idChapitre ? (parChapitre[idChapitre] || []) : cartes;
  if (!liste.length) return;
  let { file, libre, rappels } = composer(liste, !idChapitre);
  if (seulementCours) { file = liste.filter(estCours); libre = false; rappels = new Set(); if (!file.length) return; }
  session = { file, i: 0, total: file.length, faits: 0, bons: 0, xp: 0, combo: 0, libre, revues: new Set(), vue: null, rappels, echecs: {} };
  afficherCarte();
}

/* ---------- Écran d'accueil ---------- */
function accueil() {
  session = null; sauverSession();
  const mg = maitrise(cartes);
  const nv = niveau(mg);
  const dues = cartes.filter(estDue).length;
  const neuves = cartes.filter(estNeuve).length;
  const serieVivante = etat.dernierJour !== null && etat.dernierJour >= aujourdhui() - 1 ? etat.serie : 0;
  let h = `
    <div class="entete"><h1>Agré<span>gatix</span></h1><button class="roue" data-a="reglages" aria-label="Réglages">⚙</button></div>
    <div class="stats">
      <div class="stat"><b>🔥 ${serieVivante}</b><small>jour${serieVivante > 1 ? 's' : ''} de suite</small></div>
      <div class="stat"><b>${etat.xp}</b><small>XP</small></div>
      <div class="stat"><b>${Math.round(100 * mg)} %</b><small>maîtrise</small></div>
    </div>
    <div class="niveau">
      <div class="ligne"><span>Niveau ${nv.n} · <b>${nv.titre}</b></span><span>${Math.round(100 * mg)} % → ${Math.round(100 * nv.haut)} %</span></div>
      <div class="barre"><i style="width:${100 * (mg - nv.bas) / (nv.haut - nv.bas)}%"></i></div>
    </div>
    <button class="gros" data-a="lancer" data-ch="">Session du jour</button>
    <p class="sous-gros">${dues} à revoir · ${neuves} nouvelles · ${cartes.length} cartes en tout</p>`;
  const parPriorite = etat.tri === 'priorite';
  h += `<div class="tri"><button class="${parPriorite ? '' : 'actif'}" data-a="tri" data-t="programme">Par domaine</button>
    <button class="${parPriorite ? 'actif' : ''}" data-a="tri" data-t="priorite">Par priorité</button>
    <button class="aide" data-a="aide-priorites" aria-label="Comment la priorité est calculée">?</button></div>`;
  if (parPriorite) {
    const tous = Object.values(chapitres);
    for (const p of [3, 2, 1]) {
      const lot = tous.filter(ch => (ch.poids || 1) === p)
        .sort((a, b) => (b.sujets || 0) - (a.sujets || 0) || maitrise(parChapitre[a.id] || []) - maitrise(parChapitre[b.id] || []));
      if (!lot.length) continue;
      h += `<section class="domaine"><h2>${pips(p)} ${FREQ[p]} aux écrits</h2>${lot.map(tuile).join('')}</section>`;
    }
  } else {
    for (const d of programme.domaines)
      h += `<section class="domaine"><h2 style="color:${d.couleur}">${d.nom}</h2>${d.chapitres.map(tuile).join('')}</section>`;
  }
  $app.innerHTML = h;
  window.scrollTo(0, 0);
}
const pips = p => `<span class="pips p${p || 1}" aria-hidden="true"><i></i><i></i><i></i></span>`;
function tuile(ch) {
  const liste = parChapitre[ch.id] || [];
  if (!liste.length) return `<div class="tuile vide"><div class="txt"><b>${ch.nom}</b><small>§ ${ch.ref} · bientôt</small></div></div>`;
  const m = Math.round(100 * maitrise(liste));
  const aRevoir = liste.filter(estDue).length;
  const dur = enDifficulte(ch.id), aDesRappels = liste.some(estCours);
  return `<div class="tuile" style="--c:${ch.couleur}">
    <button class="corps" data-a="lancer" data-ch="${ch.id}">
      <div class="txt"><b>${ch.nom}${aRevoir ? `<span class="pastille">${aRevoir}</span>` : ''}</b>
      <small>§ ${ch.ref} · ${liste.length} cartes</small>
      <small class="freq">${pips(ch.poids)} ${FREQ[ch.poids || 1]} aux écrits${dur && aDesRappels ? ' · <em>rappels en tête</em>' : ''}</small>
      <div class="barre"><i style="width:${m}%"></i></div></div>
      <span class="pc">${m} %</span></button>
    ${aDesRappels ? `<button class="livre${dur ? ' alerte' : ''}" data-a="rappels" data-ch="${ch.id}" aria-label="Rappels de cours : ${ch.nom}">📖</button>` : ''}</div>`;
}

/* ---------- Écran de carte ---------- */
function afficherCarte() {
  const s = session;
  if (s.i >= s.file.length) return fin();
  const c = s.file[s.i];
  const v = s.vue = { carte: c, repondu: false, choisi: null, ordre: null, revue: s.revues.has(c.id) };
  if (c.type === 'qcm' || c.type === 'piste' || c.type === 'cours') v.ordre = melanger(c.choix.map((_, k) => k));
  if (c.type === 'erreur') v.ordre = c.lignes.map((_, k) => k);
  sauverSession(); dessiner();
  window.scrollTo(0, 0);
}

function dessiner() {
  const s = session, v = s.vue, c = v.carte;
  const revue = v.revue;
  let verdict = '';
  if (v.repondu) {
    const titres = { bon: ['Exact !', 'Bien vu !', 'Oui !'], possible: ['Ça se défend'], faux: ['Raté', 'Pas tout à fait', 'Aïe'] }[v.verdict];
    const reponse = c.type === 'vf' ? `<b>${c.reponse ? 'Vrai' : 'Faux'}.</b> ` : '';
    verdict = `<div class="verdict ${v.verdict}"><h3>${titres[s.faits % titres.length]}</h3>${c.explication ? `<p>${reponse}${fmt(c.explication)}</p>` : ''}</div>`;
  }
  let h = `
    <div class="haut"><button class="fermer" data-a="quitter" aria-label="Quitter">✕</button>
      <div class="barre"><i style="width:${100 * s.faits / s.total}%"></i></div>
      <span class="combo">${s.combo >= 2 ? '×' + s.combo : ''}</span></div>
    <span class="mode">${MODES[c.type]}</span>${revue ? '<span class="mode revoir">À revoir</span>' : s.rappels.has(c.id) ? '<span class="mode revoir">Prioritaire</span>' : ''}`;
  const fig = c.figure ? figure(c.figure) : '';
  const apres = c.figure && c.figure.quand === 'apres';
  if (c.type === 'cours') h += `<div class="cours"><h3>${fmt(c.titre)}</h3>${fmt(c.enonce)}${fig}</div>
    <div class="enonce"><b class="appli">Application</b>${fmt(c.question)}</div>`;
  else h += `<div class="enonce">${fmt(c.enonce)}${apres ? '' : fig}</div>`;
  h += verdict + (apres && v.repondu && c.type !== 'cours' ? `<div class="enonce">${fig}</div>` : '');

  if (c.type === 'vf') {
    if (!v.repondu) h += `<div class="vf"><button class="v" data-a="vf" data-r="1">Vrai</button><button class="f" data-a="vf" data-r="0">Faux</button></div>`;
  } else {
    const consignes = { cours: 'Lis le rappel, puis réponds.', qcm: 'Choisis la bonne proposition.', erreur: 'Touche la ligne qui contient l\'erreur.', piste: 'Quelle piste suivrais-tu ? Le bouton i rappelle l\'outil, sans dire s\'il convient.' };
    if (!v.repondu) h += `<p class="consigne">${consignes[c.type]}</p>`;
    v.ordre.forEach((k, pos) => {
      let classe = 'choix', etiquette = '', retour = '';
      if (!v.repondu) { if (v.choisi === k) classe += ' choisi'; }
      else if (c.type === 'piste') {
        const ver = c.choix[k].verdict;
        classe += ' ' + (ver === 'impasse' ? 'faux' : ver) + (v.choisi === k ? '' : ' eteint');
        etiquette = `<span class="etiquette">${{ bon: 'Bonne piste', possible: 'Jouable', impasse: 'Impasse' }[ver]}${v.choisi === k ? ' · ton choix' : ''}</span><br>`;
        retour = `<span class="retour">${fmt(c.choix[k].retour)}</span>`;
      } else {
        const bonne = c.type === 'erreur' ? c.fausse : c.bonne;
        if (k === bonne) classe += ' bon'; else if (k === v.choisi) classe += ' faux'; else classe += ' eteint';
      }
      const texte = c.type === 'piste' ? c.choix[k].titre : c.type === 'erreur' ? c.lignes[k] : c.choix[k];
      const num = c.type === 'erreur' ? `<span class="num">${pos + 1}.</span>` : '';
      const info = c.type === 'piste' ? `<button class="i" data-a="info" data-k="${k}" aria-label="Rappel">i</button>` : '';
      h += `<div class="${classe}"><button class="corps" data-a="choisir" data-k="${k}">${etiquette}${num}${fmt(texte)}${retour}</button>${info}</div>`;
    });
    if (!v.repondu) h += `<div class="pied"><button class="gros${v.choisi === null ? ' calme' : ''}" data-a="valider">Valider</button></div>`;
  }

  if (v.repondu) {
    if (c.direction) h += `<div class="direction"><b>La direction</b>${fmt(c.direction)}</div>`;
    const signale = etat.signalements.some(x => x.id === c.id);
    h += `<div class="pied"><button class="signaler${signale ? ' fait' : ''}" data-a="signaler" aria-label="Signaler cette carte">⚑</button>
      <button class="gros" data-a="suivante">Continuer</button></div>`;
  }
  $app.innerHTML = h;
}

function repondre(verdict) {
  const s = session, v = s.vue, c = v.carte;
  v.repondu = true; v.verdict = verdict;
  const revue = v.revue;
  if (!revue) {
    s.faits++;
    if (!s.libre) noter(c, verdict);
    retenir(c, verdict);
    if (verdict === 'bon') s.bons++;
  }
  if (verdict === 'faux') {
    s.combo = 0; vibrer([40, 60, 40]);
    if (!revue) {
      s.revues.add(c.id); s.file.push(c);                 // reviendra une fois en fin de session
      // Deuxième échec de la session sur un même chapitre : un rappel de cours arrive juste après.
      if (!estCours(c) && (s.echecs[c.ch] = (s.echecs[c.ch] || 0) + 1) === 2) {
        const rappel = (parChapitre[c.ch] || []).filter(x => estCours(x) && !s.file.includes(x) && !vueAujourdhui(x))
          .sort((a, b) => rang(a) - rang(b))[0];
        if (rappel) { s.file.splice(s.i + 1, 0, rappel); s.total++; s.rappels.add(rappel.id); }
      }
    }
  } else {
    s.combo = verdict === 'bon' ? s.combo + 1 : s.combo;
    const gain = revue ? 3 : (verdict === 'bon' ? 10 + Math.min(10, 2 * (s.combo - 1)) : 5);
    s.xp += gain; etat.xp += gain; vibrer(20);
  }
  marquerJour(); sauver(); sauverSession(); dessiner();
  const cible = c.type === 'cours' && document.querySelector('.verdict');
  if (cible) cible.scrollIntoView({ block: 'center', behavior: 'smooth' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fin() {
  const s = session;
  try { localStorage.removeItem(CLE_SESSION); } catch (e) { /* sans stockage */ }
  const pc = Math.round(100 * s.bons / s.total);
  const emoji = pc === 100 ? '🏆' : pc >= 70 ? '🎯' : pc >= 40 ? '💪' : '🌱';
  const mot = pc === 100 ? 'Sans faute !' : pc >= 70 ? 'Belle session' : pc >= 40 ? 'Ça rentre' : 'On reprend demain';
  $app.innerHTML = `<div class="fin"><div class="grand">${emoji}</div><h2>${mot}</h2>
    <p>${s.libre ? 'Entraînement libre : tout était déjà à jour.' : 'Les cartes ratées reviendront demain.'}</p>
    <div class="stats"><div class="stat"><b>${s.bons}/${s.total}</b><small>du premier coup</small></div>
    <div class="stat"><b>+${s.xp}</b><small>XP</small></div><div class="stat"><b>🔥 ${etat.serie}</b><small>série</small></div></div>
    <button class="gros" data-a="accueil">Retour à la carte</button></div>`;
}

/* ---------- Feuille du bas ---------- */
function ouvrir(html) { $feuille.innerHTML = html; $feuille.hidden = false; $voile.hidden = false; }
function fermer() { $feuille.hidden = true; $voile.hidden = true; }
$voile.addEventListener('click', fermer);

function feuilleInfo(k) {
  const ch = session.vue.carte.choix[k];
  ouvrir(`<h3>${fmt(ch.titre)}</h3><p>${fmt(ch.info)}</p><button class="gros calme" data-a="fermer">Fermer</button>`);
}
function feuillePriorites() {
  const e = programme.ecrits || {};
  const rangs = Object.values(chapitres).sort((a, b) => (b.poids || 1) - (a.poids || 1) || (b.sujets || 0) - (a.sujets || 0));
  ouvrir(`<h3>Présence aux écrits</h3>
    <small>Estimation par mots-clés sur ${e.sujetsLus || '?'} sujets (${e.periode || ''}) : le nombre de sujets où le vocabulaire du chapitre apparaît nettement.
    Ce n'est pas un étiquetage question par question, et les notions écrites en symboles (intégrales, séries) sont sous-comptées : leur niveau a été relevé à la main.
    En session du jour, les cartes neuves des chapitres fréquents sortent plus souvent.</small>
    <table class="rangs">${rangs.map(ch => `<tr><td>${pips(ch.poids)}</td><td>${ch.nom}</td><td>${ch.sujets || 0}/${e.sujetsLus || '?'}</td></tr>`).join('')}</table>
    <button class="gros" data-a="fermer">Fermer</button>`);
}
function feuilleSignaler() {
  const c = session.vue.carte;
  const deja = etat.signalements.find(x => x.id === c.id);
  ouvrir(`<h3>Signaler la carte ${c.id}</h3><small>Erreur de maths, énoncé ambigu, faute de frappe… Le signalement est gardé sur le téléphone et s'exporte depuis les réglages.</small>
    <textarea id="note" placeholder="Qu'est-ce qui cloche ? (facultatif)">${deja ? echapper(deja.note) : ''}</textarea>
    <button class="gros" data-a="signaler-ok">Enregistrer</button>${deja ? '<button class="gros calme" data-a="signaler-non">Retirer le signalement</button>' : ''}`);
}
function feuilleReglages() {
  ouvrir(`<h3>Réglages</h3>
    <small>${etat.signalements.length} carte(s) signalée(s) · ${Object.keys(etat.cartes).length} carte(s) déjà vues</small>
    <button class="gros calme" data-a="copier-signalements">Copier les signalements</button>
    <button class="gros calme" data-a="copier-sauvegarde">Copier la sauvegarde</button>
    <button class="gros calme" data-a="restaurer">Restaurer une sauvegarde</button>
    <button class="gros calme danger" data-a="effacer">Tout remettre à zéro</button>
    <button class="gros" data-a="fermer">Fermer</button>`);
}
async function copier(texte, quoi) {
  try { await navigator.clipboard.writeText(texte); alert(quoi + ' : copié dans le presse-papiers.'); }
  catch (e) { prompt('Copie ce texte :', texte); }
}

/* ---------- Gestion des touches ---------- */
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a, v = session && session.vue;
  switch (a) {
    case 'lancer': lancer(b.dataset.ch || null); break;
    case 'rappels': lancer(b.dataset.ch, true); break;
    case 'tri': { etat.tri = b.dataset.t; sauver(); const y = window.scrollY; accueil(); window.scrollTo(0, y); break; }
    case 'aide-priorites': feuillePriorites(); break;
    case 'accueil': accueil(); break;
    case 'quitter': if (!session.faits || confirm('Quitter la session ? Les réponses déjà données sont gardées.')) accueil(); break;
    case 'vf': repondre((b.dataset.r === '1') === v.carte.reponse ? 'bon' : 'faux'); break;
    case 'choisir': if (!v.repondu) { v.choisi = Number(b.dataset.k); sauverSession(); dessiner(); } break;
    case 'valider': {
      if (v.choisi === null) break;
      const c = v.carte;
      if (c.type === 'piste') { const ver = c.choix[v.choisi].verdict; repondre(ver === 'impasse' ? 'faux' : ver); }
      else repondre(v.choisi === (c.type === 'erreur' ? c.fausse : c.bonne) ? 'bon' : 'faux');
      break;
    }
    case 'suivante': session.i++; afficherCarte(); break;
    case 'info': feuilleInfo(Number(b.dataset.k)); break;
    case 'fermer': fermer(); break;
    case 'signaler': feuilleSignaler(); break;
    case 'signaler-ok': {
      const id = v.carte.id, note = document.getElementById('note').value.trim();
      etat.signalements = etat.signalements.filter(x => x.id !== id).concat({ id, note, jour: new Date().toISOString().slice(0, 10) });
      sauver(); fermer(); dessiner(); break;
    }
    case 'signaler-non': etat.signalements = etat.signalements.filter(x => x.id !== v.carte.id); sauver(); fermer(); dessiner(); break;
    case 'reglages': feuilleReglages(); break;
    case 'copier-signalements': copier(JSON.stringify(etat.signalements, null, 1), 'Signalements'); break;
    case 'copier-sauvegarde': copier(JSON.stringify(etat), 'Sauvegarde'); break;
    case 'restaurer': {
      const t = prompt('Colle ici une sauvegarde :');
      if (!t) break;
      try { const o = JSON.parse(t); if (typeof o.xp !== 'number' || !o.cartes) throw 0; etat = Object.assign(charger(), o); sauver(); fermer(); accueil(); }
      catch (e) { alert('Sauvegarde illisible.'); }
      break;
    }
    case 'effacer': if (confirm('Effacer toute la progression ? Action définitive.')) { localStorage.removeItem(CLE); localStorage.removeItem(CLE_SESSION); etat = charger(); fermer(); accueil(); } break;
  }
});

/* ---------- Démarrage ---------- */
async function demarrer() {
  try {
    programme = await (await fetch('data/index.json')).json();
    const ids = programme.domaines.flatMap(d => d.chapitres).filter(ch => ch.cartes).map(ch => ch.id);
    const lots = await Promise.all(ids.map(id => fetch(`data/cartes/${id}.json`).then(r => r.json())));
    cartes = lots.flat();
    for (const d of programme.domaines) for (const ch of d.chapitres) chapitres[ch.id] = Object.assign(ch, { couleur: d.couleur });
    for (const c of cartes) (parChapitre[c.ch] = parChapitre[c.ch] || []).push(c);
    if (!reprendreSession()) accueil();
  } catch (e) {
    $app.innerHTML = '<p class="chargement">Impossible de charger les cartes. Vérifie la connexion puis recharge la page.</p>';
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
demarrer();
