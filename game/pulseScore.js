// OTOMATİK KOPYA — kaynak: src/game/pulseScore.js (düzenlemeyi orada yapın)
/**
 * PulseCity puan motoru — saf fonksiyon, kayıtlardan puanı yeniden hesaplar.
 * Aynı kod sunucuda da çalışır (server/game/pulseScore.js, scripts ile kopyalanır):
 * sıralama puanı sunucunun damgaladığı tarihlerle hesaplanır.
 *
 * Kurallar (yol haritası):
 *  Son günden önce ödeme +20 · tam son gün +10 · gecikme -30
 *  Haftayı bütçe içinde kapatma +50 · birikime para ekleme +15 · hedefi tamamlama +200
 *  Günlük kayıt serisi +5 × seri (en çok +50) · borcu tamamen kapatma +300
 * Hile koruması: geçmiş tarihli kayıtlar puan getirmez, vadesine 10 günden fazla varken
 * "ödendi" yapılan taksit puansızdır, günlük puan tavanı vardır, silinen kayıt sayılmaz.
 */

const STAGES = [
  { name: 'Köy', min: 0, unlocks: 'Tek ev, küçük bahçe' },
  { name: 'Kasaba', min: 1000, unlocks: 'Market, park, yollar' },
  { name: 'Şehir', min: 5000, unlocks: 'Banka, okul, gece ışıkları' },
  { name: 'Metropol', min: 15000, unlocks: 'Gökdelenler, metro, stadyum' },
  { name: 'Pulse Kenti', min: 40000, unlocks: 'PayPulse kulesi, havai fişek gösterisi' },
];

const LEAGUES = ['Bronz', 'Gümüş', 'Altın', 'Platin', 'Elmas'];

const RULES = [
  { label: 'Ödemeyi son günden önce yapmak', pts: '+20' },
  { label: 'Ödemeyi tam son gün yapmak', pts: '+10' },
  { label: 'Gecikmiş ödeme', pts: '-30' },
  { label: 'Haftayı bütçe limiti içinde kapatmak', pts: '+50' },
  { label: 'Birikim hedefine para eklemek', pts: '+15' },
  { label: 'Birikim hedefini tamamlamak', pts: '+200' },
  { label: 'Her gün kayıt girmek (seri)', pts: '+5 × seri (en çok +50)' },
  { label: 'Bir borcu tamamen kapatmak', pts: '+300' },
];

const DAILY_CAP = 300;
const MAX_PAID_PER_DAY = 8;
const EARLY_WINDOW_DAYS = 10;
const DAY = 86400000;
const TR_OFFSET = 3 * 3600000; // Türkiye saati (UTC+3): istemci ve sunucu aynı günü saysın

const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d;
};
/** Türkiye saatine göre gün numarası (1970'ten beri) */
const dayOf = (d) => Math.floor((d.getTime() + TR_OFFSET) / DAY);
/** Gün numarasından haftanın Pazartesi'si */
const weekStartOf = (n) => n - ((n + 3) % 7); // 1970-01-01 Perşembe

function stageFor(total) {
  let i = 0;
  STAGES.forEach((s, idx) => { if (total >= s.min) i = idx; });
  const next = STAGES[i + 1] || null;
  const progress = next ? (total - STAGES[i].min) / (next.min - STAGES[i].min) : 1;
  return { index: i, stage: STAGES[i], next, progress: Math.max(0, Math.min(1, progress)) };
}

function computePulse({ payments = [], goals = [], budgets = {}, now = new Date() } = {}) {
  const todayN = dayOf(now);
  const events = []; // { day, pts, kind, label }
  const lateSeq = []; // vadeye göre sıralanacak: { dueN, late }
  const activityDays = new Set();
  let firstActivity = null;
  let overdueNow = 0, debtsClosed = 0, goalsDone = 0;

  const markActivity = (n) => {
    if (n > todayN) return;
    activityDays.add(n);
    if (firstActivity === null || n < firstActivity) firstActivity = n;
  };

  for (const p of payments) {
    const plan = Array.isArray(p.installmentPlan) ? p.installmentPlan : [];
    const created = toDate(p.createdAt);
    const createdN = created ? dayOf(created) : null;
    if (createdN !== null) markActivity(createdN);
    const label = p.title || 'Ödeme';

    let allPaid = plan.length > 0, eligible = createdN !== null, lastPaidN = null;
    for (const inst of plan) {
      const due = toDate(inst.date);
      if (!due) continue;
      const dueN = dayOf(due);
      const backdated = createdN !== null && dueN < createdN;
      if (backdated) eligible = false;

      if (!inst.isPaid) {
        allPaid = false;
        if (dueN < todayN && !backdated) {
          overdueNow++;
          events.push({ day: dueN + 1, pts: -30, kind: 'late', label });
          lateSeq.push({ dueN, late: true });
        }
        continue;
      }
      if (backdated) continue;

      const paid = toDate(inst.paidAt);
      if (!paid) {
        // Eski kayıt: ödeme anı bilinmiyor → vadesi geçmişse son gün ödenmiş say
        if (dueN <= todayN) {
          events.push({ day: dueN, pts: 10, kind: 'onday', label });
          lateSeq.push({ dueN, late: false });
          lastPaidN = Math.max(lastPaidN ?? dueN, dueN);
        }
        continue;
      }
      const paidN = Math.min(dayOf(paid), todayN);
      lastPaidN = Math.max(lastPaidN ?? paidN, paidN);
      if (paidN > dueN) {
        events.push({ day: paidN, pts: -30, kind: 'late', label });
        lateSeq.push({ dueN, late: true });
      } else if (dueN - paidN <= EARLY_WINDOW_DAYS && (createdN === null || paidN > createdN)) {
        // Eklendiği gün "ödendi" yapılan taksit puansız: sahte ödeme açıp hemen kapatmak işe yaramaz
        const early = paidN < dueN;
        events.push({ day: paidN, pts: early ? 20 : 10, kind: early ? 'early' : 'onday', label });
        lateSeq.push({ dueN, late: false });
      }
    }
    // Borç kapatma: en az 2 taksit, geçmiş tarihli değil, açılıştan en az 30 gün sonra bitmiş
    if (allPaid && plan.length >= 2 && eligible && lastPaidN !== null && lastPaidN - createdN >= 30) {
      debtsClosed++;
      events.push({ day: lastPaidN, pts: 300, kind: 'debt', label });
    }
  }

  // Birikim hedefleri: her hedefe günde en fazla bir katkı puanı
  for (const g of goals) {
    let sum = 0, done = false;
    const seen = new Set();
    const hist = [...(g.history || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const h of hist) {
      const d = toDate(h.date);
      if (!d) continue;
      const n = Math.min(dayOf(d), todayN);
      const amt = Number(h.amount) || 0;
      sum += amt;
      if (amt > 0) {
        markActivity(n);
        if (!seen.has(n)) {
          seen.add(n);
          events.push({ day: n, pts: 15, kind: 'goal', label: g.name || 'Hedef' });
        }
      }
      if (!done && Number(g.target) > 0 && sum >= Number(g.target)) {
        done = true;
        goalsDone++;
        events.push({ day: n, pts: 200, kind: 'goalDone', label: g.name || 'Hedef' });
      }
    }
  }

  // Kayıt serisi: art arda kayıt girilen günler
  const days = [...activityDays].sort((a, b) => a - b);
  let run = 0, prev = null;
  for (const n of days) {
    run = prev !== null && n === prev + 1 ? run + 1 : 1;
    prev = n;
    events.push({ day: n, pts: Math.min(5 * run, 50), kind: 'streak', label: `${run}. gün serisi` });
  }
  const streak = prev !== null && todayN - prev <= 1 ? run : 0;

  // Haftalık bütçe: son 4 tamamlanmış hafta, toplam aylık limitin haftalık payı içinde kalındıysa
  const monthly = Number(budgets && budgets.__total) || 0;
  if (monthly > 0 && firstActivity !== null) {
    const weekLimit = (monthly * 7) / 30;
    const thisWeek = weekStartOf(todayN);
    for (let w = 1; w <= 4; w++) {
      const start = thisWeek - 7 * w;
      if (start < firstActivity) break;
      let spent = 0;
      for (const p of payments) for (const inst of p.installmentPlan || []) {
        const d = toDate(inst.date);
        if (!d) continue;
        const n = dayOf(d);
        if (n >= start && n < start + 7) spent += Number(inst.amount) || 0;
      }
      if (spent <= weekLimit) events.push({ day: start + 7, pts: 50, kind: 'budget', label: 'Bütçe içinde bir hafta' });
    }
  }

  // Günlük tavan: pozitif puanlar günde en çok DAILY_CAP, cezalar her zaman sayılır
  // Ayrıca günde en çok MAX_PAID_PER_DAY taksit ödemesi puan getirir
  const byDay = new Map();
  for (const e of events) {
    if (e.day > todayN) continue;
    const o = byDay.get(e.day) || { pos: 0, neg: 0, paid: 0 };
    if (e.kind === 'early' || e.kind === 'onday') {
      if (o.paid >= MAX_PAID_PER_DAY) { e.pts = 0; byDay.set(e.day, o); continue; }
      o.paid++;
    }
    if (e.pts > 0) o.pos += e.pts; else o.neg += e.pts;
    byDay.set(e.day, o);
  }
  const thisWeek = weekStartOf(todayN);
  let total = 0, week = 0, lastWeek = 0, cappedDays = 0;
  for (const [n, o] of byDay) {
    if (o.pos > DAILY_CAP && n >= todayN - 7) cappedDays++;
    const v = Math.min(o.pos, DAILY_CAP) + o.neg;
    total += v;
    if (n >= thisWeek) week += v;
    else if (n >= thisWeek - 7) lastWeek += v;
  }
  total = Math.max(0, total);

  lateSeq.sort((a, b) => a.dueN - b.dueN);
  const last3 = lateSeq.slice(-3);
  const damaged = last3.length === 3 && last3.every(x => x.late);
  const lateIn = (days) => events.some(e => e.kind === 'late' && e.day >= todayN - days);
  const ageDays = firstActivity === null ? 0 : todayN - firstActivity;

  const badges = [
    { id: 'neverLate', name: 'Hiç gecikmeyen', desc: '90 gün boyunca gecikmesiz', icon: '⏱️', earned: ageDays >= 90 && !lateIn(90) },
    { id: 'debtHunter', name: 'Borç avcısı', desc: 'Bir borcu tamamen kapat', icon: '🏹', earned: debtsClosed > 0 },
    { id: 'subCleaner', name: 'Abonelik temizleyici', desc: 'Gereksiz bir aboneliği iptal et', icon: '🧹', earned: false },
    { id: 'goalMaster', name: 'Birikim ustası', desc: 'Bir birikim hedefini tamamla', icon: '🏆', earned: goalsDone > 0 },
  ];

  const recent = events
    .filter(e => e.day <= todayN && e.kind !== 'streak' && e.pts !== 0)
    .sort((a, b) => b.day - a.day)
    .slice(0, 12)
    .map(e => ({ ...e, date: new Date(e.day * DAY).toISOString().slice(0, 10) }));

  return {
    total, week, lastWeek, streak,
    ...stageFor(total),
    overdueNow,
    rain: overdueNow > 0,
    damaged,
    rareBuilding: ageDays >= 30 && !lateIn(30),
    badges,
    recent,
    stats: { debtsClosed, goalsDone, activeDays: activityDays.size },
    suspicious: cappedDays >= 3, // olağandışı artış: sıralamada incelemeye düşer
  };
}

module.exports = { STAGES, LEAGUES, RULES, DAILY_CAP, MAX_PAID_PER_DAY, stageFor, computePulse };
