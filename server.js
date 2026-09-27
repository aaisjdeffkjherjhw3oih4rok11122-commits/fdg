/**
 * ========================================================================
 *  server.js — Backend كامل لمشروع Telegram Mini App (SHIB Rewards)
 *  يعمل الآن على Railway كسيرفر Node.js عادي (تم تحويله من Cloudflare Workers)
 *  قاعدة البيانات: Firebase Realtime Database عبر REST API
 * ========================================================================
 *
 *  Environment Variables (تُضاف من Railway Dashboard > Variables):
 *
 *    FIREBASE_DATABASE_URL  -> *مطلوب دائمًا* (مثال: https://your-project.firebaseio.com)
 *                              لازم يكون موجود كـ Env Var لأن السيرفر يحتاجه فقط
 *                              للوصول لقاعدة البيانات قبل قراءة أي إعدادات منها.
 *
 *    BOT_TOKEN               -> توكن بوت التليجرام (Secret) — *احتياطي فقط*.
 *    BOT_USERNAME             -> يوزر البوت بدون @ — *احتياطي فقط*.
 *
 *  ملاحظة مهمة جدًا (تغيير عن النسخة السابقة):
 *    BOT_TOKEN و BOT_USERNAME أصبحا قابلين للتعديل مباشرة من Firebase تحت
 *    المسار config/botToken و config/botUsername. لو موجودين في Firebase
 *    هيتم استخدامهم، ولو غير موجودين هيتم استخدام Env Vars كقيمة احتياطية
 *    (Fallback) ثم تُحفظ في Firebase تلقائيًا كقيمة مبدئية يمكن تعديلها بعدها.
 *    وبالمثل كل قيم المكافآت والسحب والاشتراك الإجباري قابلة للتعديل من
 *    Firebase مباشرة تحت عقدة config/ — الكود فقط يضع قيم مبدئية لو الحقل
 *    غير موجود، ولا يلمس أي قيمة موجودة بالفعل (حتى لو غيّرنا القيم
 *    الافتراضية في كود جديد مستقبلًا).
 *
 *  ملاحظة أمان مهمة:
 *    لازم تضبط Rules بتاعة Firebase Realtime Database عشان القراءة/الكتابة
 *    تتم فقط من السيرفر (الـ Worker)، مينفعش تسيب الداتابيز Public للكل،
 *    خصوصًا الآن إن config/ ممكن يحتوي على BOT_TOKEN نفسه.
 *    أبسط حل: اجعل القواعد ".read": false / ".write": false من الـ Client.
 * ========================================================================
 */

// ──────────────────────────────────────────────────────────────────────
//  Polyfill: Cloudflare Workers بيوفر "crypto" (Web Crypto API) كـ global
//  جاهز دايمًا. في Node.js الميزة دي بقت متاحة تلقائيًا كـ global بس من
//  الإصدار 19 وما بعده — فلو Railway شغّل السيرفر بإصدار أقدم (زي 18)،
//  "crypto" هتكون undefined ويطلع خطأ "crypto is not defined". السطرين
//  دول بيضمنوا إنها موجودة مهما كانت نسخة Node.
// ──────────────────────────────────────────────────────────────────────
import { webcrypto } from 'node:crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

// ──────────────────────────────────────────────────────────────────────
//  ثوابت عامة للنظام — كل القيم دي قابلة للتعديل من Firebase تحت config/
//  العملة المستخدمة في كل أنحاء البوت: PMT
//  (هذه القيم تُستخدم فقط كـ "قيمة مبدئية" أول مرة، ولا يتم الكتابة فوق
//   أي قيمة موجودة بالفعل في Firebase تم تعديلها يدويًا)
// ──────────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  botUsername: 'Pmt_Gram_Bot',
  referralReward: 4000,        // مكافأة الإحالة (تُصرف مرة واحدة فقط بعد مشاهدة 10 إعلانات)
  comboReward: 5000,           // مكافأة الكومبو اليومي (SHIBA)
  taskDefaultReward: 500,      // مكافأة افتراضية لمهام القنوات/البوتات
  dailyBonusReward: 500,       // المكافأة اليومية
  adReward: 200,               // قيمة احتياطية فقط (fallback) لو الشركة مش موجودة في adCompanies/
  adDailyLimit: 20,
  adCompanyDailyLimit: 10,     // قيمة احتياطية فقط (fallback)
  // أقل وقت (بالمللي ثانية) لازم يعدي بين /startAdView و/claimAdReward
  // لنفس التذكرة. أي طلب claim بيوصل أسرع من كده معناه إن مفيش وقت كافي
  // لمشاهدة إعلان فعلي حصل فعلًا — على الأرجح سكريبت بينادي الإندبوينتين
  // ورا بعض على طول من غير أي إعلان حقيقي. الطلب برضه يترفض بس التذكرة
  // نفسها تفضل صالحة (يقدر يعيد المحاولة بعد ما الوقت يعدي، لحد ما تنتهي
  // صلاحيتها الأصلية AD_NONCE_TTL_MS). القيمة الافتراضية متحفظة (5 ثواني)
  // عشان ماترفضش مستخدمين حقيقيين على نت بطيء أو إعلانات قصيرة جدًا؛ لو
  // حابب حماية أقوى ارفعها لحد قريب من مدة الإعلان الفعلية (15-30 ثانية).
  adMinWatchMs: 5000,
  // إعدادات كل شركة إعلانات على حدة: المكافأة والحد اليومي المسموح لكل
  // شركة بشكل مستقل. تُقرأ من Firebase تحت config/adCompanies/<company>/
  // ولو الشركة غير موجودة، يتم استخدام adReward و adCompanyDailyLimit
  // كقيمة احتياطية أعلاه.
  adCompanies: {
    adsgram: { reward: 200, dailyLimit: 10 },
    gigapub: { reward: 200, dailyLimit: 10 },
    monetix: { reward: 200, dailyLimit: 10 },
  },
  minWithdrawal: 50000,        // أقل مبلغ يمكن سحبه (SHIBA)
  tonConversionRate: 10000,    // 10,000 PMT = 1 TON

  // ── Cloudflare Turnstile (CAPTCHA) ─────────────────────────────
  // turnstileSiteKey يُرسل للواجهة الأمامية (Public). turnstileSecretKey
  // يُستخدم فقط من السيرفر للتحقق عبر siteverify، ولا يُرسل للواجهة أبدًا
  // (يتم حذفه من clientConfig في handleGetState). كلاهما قابل للتعديل من
  // Firebase تحت config/turnstileSiteKey و config/turnstileSecretKey.
  turnstileSiteKey: '0x4AAAAAACOf6mYyukJx5XVy',
  turnstileSecretKey: '0x4AAAAAACOf6iTNX4O5_WP9Kt07Kimr8FU',
  // كل كام إعلان (متتالي) يظهر بعده الكابتشا قبل صرف المكافأة
  turnstileAdsInterval: 3,
  // دومين الواجهة الأمامية المتوقع (بدون https://، بدون مسار) — لو
  // اتحدد، السيرفر يرفض أي توكن Turnstile راجع منه hostname مختلف عن
  // القيمة دي (يمنع استخدام توكن اتحل على دومين تاني مع سيرفرنا).
  // سيبها فاضية لو مش عايز التحقق ده يتفعّل. قابلة للتعديل من Firebase
  // تحت config/turnstileExpectedHostname.
  turnstileExpectedHostname: '',
  depositWallet: 'UQAACNWWtTtN7ILkhRERwYUTzo06Bd1Tv_8Yk5gPioIMFoUD',
  withdrawalEnabled: true,     // تشغيل/إيقاف نظام السحب بالكامل
  mandatorySubEnabled: true,   // تشغيل/إيقاف الاشتراك الإجباري بالكامل
  miningReward: 50,
  miningDurationMs: 60 * 60 * 1000,
  gameDailyLimit: 3,           // عدد مرات لعب كل لعبة المسموح بها يوميًا لكل مستخدم
  pricePer100MembersTon: 0.15, // سعر كل 100 عضو مطلوب في "ترويج القناة" بعملة TON
  pricePer100MembersShiba: 200000,
  pricePer100MembersUsd: 1,

  // ═══════ تصنيف الإحالات الأسبوعي (Weekly Referral Contest) ═══════
  // مدة كل مسابقة أسبوعية بالمللي ثانية — الافتراضي 7 أيام بالظبط.
  // قابلة للتعديل من Firebase تحت config/weeklyContestDurationMs لو
  // حبيت تخليها مدة مختلفة (تجريبيًا مثلًا).
  weeklyContestDurationMs: 7 * 24 * 60 * 60 * 1000,
  // جوائز المراكز من 1 إلى 10 بعملة TON بالترتيب — مجموعها = 3 TON بالظبط
  // (1 + 0.5 + 0.5 + 0.25 + 0.25 + 0.1×5). قابلة للتعديل بالكامل من
  // Firebase تحت config/weeklyContestPrizesTon (لازم تفضل 10 عناصر بالظبط).
  weeklyContestPrizesTon: [1, 0.5, 0.5, 0.25, 0.25, 0.1, 0.1, 0.1, 0.1, 0.1],
};

// عنوان محفظة الإيداع مأخوذ من نظام الإيداع العامل (server 58).
const DEPOSIT_RECEIVER_WALLET = 'UQAACNWWtTtN7ILkhRERwYUTzo06Bd1Tv_8Yk5gPioIMFoUD';

// ───────── مهام الدعوة (Invite) الثابتة — تُنشأ مرة واحدة فقط إذا لم تكن
// موجودة، وبعد ذلك تصبح قابلة للتعديل بالكامل من Firebase (لا يتم
// التعديل عليها تلقائيًا مرة أخرى حتى لو الكود تغيّر) ─────
const FIXED_INVITE_TASKS = [
  { id: 'invite_1',   title: 'Invite 1 user',    requiredReferrals: 1,   reward: 1000 },
  { id: 'invite_10',  title: 'Invite 10 users', requiredReferrals: 10,  reward: 10000 },
  { id: 'invite_25',  title: 'Invite 25 users',   requiredReferrals: 25,  reward: 25000 },
  { id: 'invite_50',  title: 'Invite 50 users',   requiredReferrals: 50,  reward: 50000 },
  { id: 'invite_100', title: 'Invite 100 users',  requiredReferrals: 100, reward: 100000 },
];

// ───────── قنوات الاشتراك الإجباري الافتراضية — تُنشأ مرة واحدة فقط لو
// عقدة mandatoryChannels/ غير موجودة بالمرة في Firebase. بعد ذلك يمكن
// إضافة/حذف/تعديل أي قناة مباشرة من Firebase تحت نفس المسار ─────
const DEFAULT_MANDATORY_CHANNELS = [
  { id: 'panda_mining_news', title: 'Panda Mining News', link: 'https://t.me/PandaMiningNews', username: 'PandaMiningNews', status: 'active' },
];

// مجموعة الإيموجيز المستخدمة في الكومبو اليومي
const COMBO_EMOJI_POOL = ['🦴', '🏠', '🎾', '🍖'];

// ───────── مهام "الانضمام لبوت" (category: bots) لا يمكن التحقق منها
// بشكل حقيقي عبر Telegram Bot API (مفيش getChatMember على بوت تاني)،
// فبدلاً من التحقق الحقيقي، نفرض فترة انتظار حقيقية بعد فتح رابط
// البوت (مُسجَّلة من السيرفر، وليست مجرد مؤقّت في الواجهة يمكن تجاوزه)
// قبل السماح للمستخدم بالضغط على Verify واستلام المكافأة ─────
const BOT_TASK_WAIT_SECONDS = 15;

// ───────── عجلة الحظ (Lucky Wheel) — 8 قطاعات بالترتيب المعروض في الواجهة،
// كل قطاع له "وزن" (weight) يحدد احتمالية الفوز به (الأوزان الأكبر = احتمال
// أعلى). المجموع = 1000 لتسهيل حساب النسبة المئوية ─────
const WHEEL_SEGMENTS = [
  { reward: 100,   weight: 250 }, // 25%
  { reward: 500,   weight: 180 }, // 18%
  { reward: 0,     weight: 100 }, // 10%
  { reward: 1000,  weight: 140 }, // 14%
  { reward: 250,   weight: 200 }, // 20%
  { reward: 2000,  weight: 80  }, //  8%
  { reward: 5000,  weight: 40  }, //  4%
  { reward: 10000, weight: 10  }, //  1%
];
const WHEEL_REFERRALS_PER_SPIN = 2; // كل عدد إحالات نشطة (Active) دي = لفة واحدة مجانية

// ───────── مهمة "Promote Your Channel" — تسعير ترويج القناة بالمقابل لعدد
// الأعضاء الجدد المطلوبين: كل 100 عضو = 200,000 شيبا (≈ 1 دولار) ─────
const PRICE_PER_100_MEMBERS_SHIBA = 200000;
const PRICE_PER_100_MEMBERS_USD = 1;

// مدة صلاحية initData (بالثواني) لحماية Replay — هنا 24 ساعة
const INIT_DATA_MAX_AGE = 24 * 60 * 60;

// إعدادات الـ Rate Limiting البسيط (تخزين في الذاكرة الخاصة بالـ Isolate)
const RATE_LIMIT_WINDOW_MS = 10 * 1000; // نافذة 10 ثواني
const RATE_LIMIT_MAX_REQ = 20;          // أقصى عدد طلبات في النافذة

const rateLimitStore = new Map();      // key -> [timestamps]
const usedInitDataHashes = new Map();  // hash -> expireAt (replay protection)

// ────────────────────────────────────────────────────────────────────
//  تذاكر مشاهدة الإعلان (Ad View Tickets) — حماية /claimAdReward من أي
//  سكريبت/بوت بايثون بينادي الإندبوينت مباشرة من غير ما يمر فعليًا
//  بمسار مشاهدة الإعلان في الواجهة.
//
//  الفكرة: /startAdView يولّد توكن عشوائي غير قابل للتخمين (nonce) ويحفظه
//  في الذاكرة (مربوط بـ telegramId + company + fingerprint + وقت انتهاء
//  الصلاحية)، ويرجعه للواجهة كـ "adTicket". الواجهة تعرض الإعلان، وبعد
//  اكتمال المشاهدة فعليًا تنادي /claimAdReward وترفق نفس الـ adTicket.
//  السيرفر هو الوحيد اللي يقدر يتحقق من صحة التذكرة (مش الواجهة)، والتذكرة
//  تتحذف نهائيًا أول ما تُستخدم بنجاح (single-use)، فمينفعش تتكرر.
//
//  ملحوظة مهمة: التوكن هنا عبارة عن نص عشوائي (Random Nonce) بيتم تخزين
//  بياناته بالكامل في الذاكرة على السيرفر — مفيش أي "تشفير" الواجهة
//  محتاجة تفكه. ده أقوى بكتير من فكرة تشفير/تعمية بيانات على الواجهة
//  والسيرفر يفكها، لأن أي كود شغال جوه الواجهة (JS) ممكن أي حد يفتحه
//  ويقرأه ويعمل reverse-engineer له، فأي خوارزمية "تخليط" أو تشفير موجودة
//  في كود الواجهة نفسها تبقى معروفة لأي حد يحلل الكود (بما فيهم سكريبت
//  بايثون)، ومبقتش سر فعليًا. أما هنا فالسيرفر وحده اللي عارف قيمة
//  الـ adTicket وممين ينتمي، والواجهة مجرد "بتنقل" التوكن زي ما استلمته
//  من غير ما تحتاج تفهم أو تفك أي حاجة فيه.
// ────────────────────────────────────────────────────────────────────
const AD_NONCE_TTL_MS = 2 * 60 * 1000; // صلاحية التذكرة: دقيقتين
const adNonceStore = new Map();        // adTicket -> { telegramId, company, fingerprint, issuedAt, expireAt, claiming, pulses }

function cleanupExpiredAdNonces() {
  const now = Date.now();
  for (const [ticket, rec] of adNonceStore) {
    if (rec.expireAt < now) adNonceStore.delete(ticket);
  }
}

function generateAdTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(24)); // 192-bit، مستحيل عمليًا تخمينه
  return bufferToHex(bytes.buffer);
}

// ────────────────────────────────────────────────────────────────────
//  "نبضات" أثناء مشاهدة الإعلان (session pulses) — طبقة حماية إضافية
//  فوق adTicket. الفكرة: طول ما الإعلان بيتعرض فعليًا، الواجهة بتنادي
//  /sessionSync كل ~2 ثانية (5 مرات إجمالًا). كل نداء لازم يرجع فيه
//  آخر كود استلمته من النداء اللي قبله (أو فاضي في أول مرة)، والسيرفر
//  يرجّع كود جديد عشوائي. النتيجة: سلسلة من 5 أكواد يصدرها السيرفر
//  (n1..n5) + 5 قيم يردّها الكلاينت (echo لكل كود سابق) = 10 قيمة
//  بتتبادل فعليًا بين الطرفين طول مدة المشاهدة. عند /claimAdReward
//  لازم يترفق نفس الـ 5 أكواد اللي استلمها بالترتيب — أي قيمة غلط أو
//  متكررة معناها التسلسل اتلعب فيه (سكريبت بيولّد/يعيد قيم من عنده
//  بدل ما يتبع النداءات الحقيقية) فالطلب يترفض فورًا (بدون حظر الحساب).
//  أي نقص في عدد النبضات (مثلاً الشبكة اتقطعت) بيخلي claimAdReward يفشل
//  برضه من غير حظر — ممكن يعيد المحاولة بمشاهدة إعلان جديد.
// ────────────────────────────────────────────────────────────────────
const AD_PULSE_COUNT = 5;          // أقصى عدد نبضات بيتجمع لكل مشاهدة إعلان (مش شرط تكتمل كلها)
const AD_PULSE_MIN_REQUIRED = 1;   // أقل عدد نبضات مقبول عند المطالبة — إعلانات قصيرة (أقل من adMinWatchMs)
                                    // ممكن متلحقش تجمع 5 نبضات كاملة، فبنقبل أي عدد حقيقي ولو نبضة واحدة
const AD_PULSE_MIN_GAP_MS = 1200;  // أقل فاصل مسموح بين نبضتين (يمنع النداء الفوري المتكرر)
const AD_PULSE_MAX_GAP_MS = 6000;  // أكتر فاصل مسموح قبل ما نعتبر السلسلة "باظت"

function generatePulseCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return bufferToHex(bytes.buffer);
}

// رفض عادي (بدون حظر) لأي خطأ في التحقق من سلسلة النبضات أثناء مشاهدة
// الإعلان. الحساب لا يُحظر تلقائيًا أبدًا هنا — فقط يترفض الطلب الحالي
// برسالة واضحة، والمستخدم يقدر يعيد المحاولة بمشاهدة إعلان جديد من البداية.
function rejectAdPulseError(env, telegramId, reasonCode) {
  return fail('Ad verification failed. Please watch the ad again from the start.', 400);
}

// ════════════════════════════════════════════════════════════════════
//  نظام الحماية ضد تعدد الحسابات (Device Fingerprint Multi-Account Guard)
//  ------------------------------------------------------------------
//  النسخة القديمة (10 طبقات) كانت بتعمل عدد كبير من عمليات القراءة/
//  الكتابة على كل طلب واحد بس (devices/, device_links/, device_id_map/,
//  device_signal_map/ لكل إشارة على حدة, ip_counters/, fraud_logs/,
//  fraud_logs_common_fp/...)، لأن كل ده كان بينادى جوه checkAntiFraud
//  على *كل* طلب API (كل الأكشنز، مش بس أول تسجيل دخول).
//
//  الكود ده اتشال بالكامل، ومكانه دلوقتي منطق واحد فقط، مبني حصريًا على
//  اللي كان موجود في multi-account-protection.server.js اللي وصلني:
//
//    - checkUserBlocked  → قراءة واحدة بس (blocks/{id}) بتتنادى على كل
//      طلب، بدل قراءة/كتابة عدة مسارات منفصلة زي الأول.
//    - المسح الكامل لجدول users (checkDeviceFingerprintMultiAccount)،
//      اللي هو العملية المكلفة فعلاً، بقى بينادى *مرة واحدة بس* لحظة
//      إنشاء حساب جديد كليًا (جوه getOrCreateUser تحت) — مش على كل طلب.
//    - مفيش تاني: مفيش device_links, device_id_map, device_signal_map,
//      ip_counters, fraud_logs, fraud_logs_common_fp, devices/. بصمة
//      الجهاز بقت بتتخزن كحقل واحد (deviceFingerprint) جوه users/{id}
//      نفسه، ومفيش أي مسار إضافي منفصل.
// ════════════════════════════════════════════════════════════════════
const MAG_BLOCKS_PATH = 'blocks';
const MAG_USERS_PATH  = 'users';

// تنسيق البصمة لازم يكون SHA-256 (64 خانة hex) عشان نعتبرها موثوقة كفاية
// نبني عليها حظر. أي حاجة تانية (زي fallback الـ base64 القصير لما
// crypto.subtle مش متاح في المتصفح) بيتم تجاهلها بهدوء من غير حظر خطأ.
function validateFingerprintFormat(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'string') {
    return { valid: false, error: 'Fingerprint is required' };
  }
  const sha256Regex = /^[a-f0-9]{64}$/i;
  if (!sha256Regex.test(fingerprint)) {
    return { valid: false, error: 'Invalid fingerprint format. Must be 64-character SHA-256 hash' };
  }
  return { valid: true };
}

// بتتنادى على كل طلب — قراءة واحدة بس (blocks/{userId}).
async function checkUserBlocked(env, userId) {
  try {
    const blockData = await dbGet(env, `${MAG_BLOCKS_PATH}/${userId}`);
    if (!blockData) return false;
    return {
      isBlocked: true,
      reason: blockData.reason || 'Account blocked',
      violation: blockData.violation || 'UNKNOWN',
      deviceFingerprint: blockData.deviceFingerprint || null,
    };
  } catch (error) {
    console.error('Error checking user block:', error);
    return false;
  }
}

async function applyBlock(env, userId, blockData) {
  try {
    const blockInfo = {
      userId,
      reason: blockData.reason || 'System violation detected',
      violation: blockData.violation || 'UNKNOWN',
      appliedAt: Date.now(),
      permanent: true,
      action: blockData.action || 'UNKNOWN',
      details: blockData.details || 'No details',
      deviceFingerprint: blockData.deviceFingerprint || 'Unknown',
    };
    await dbSet(env, `${MAG_BLOCKS_PATH}/${userId}`, blockInfo);
    await dbUpdate(env, `${MAG_USERS_PATH}/${userId}`, {
      isBlocked: true,
      blockReason: blockInfo.reason,
      blockedAt: Date.now(),
    });
    return true;
  } catch (error) {
    console.error('Error applying block:', error);
    return false;
  }
}

// المسح الكامل لجدول users بحثًا عن حساب تاني بنفس بصمة الجهاز. مكلفة
// نسبيًا (بتقرا كل المستخدمين)، فبتتنادى مرة واحدة بس عند إنشاء حساب
// جديد فعليًا (guardNewAccountDevice تحت)، أبدًا على طلب مستخدم موجود.
async function checkDeviceFingerprintMultiAccount(env, deviceFingerprint, currentUserId) {
  try {
    if (!deviceFingerprint) return { deviceAlreadyUsed: false };

    const usersData = (await dbGet(env, MAG_USERS_PATH)) || {};
    const existingAccounts = [];

    for (const [userId, userData] of Object.entries(usersData)) {
      if (String(userId) === String(currentUserId)) continue;
      if (userData.deviceFingerprint !== deviceFingerprint) continue;
      existingAccounts.push({ userId, joinDate: userData.createdAt || null });
    }

    if (!existingAccounts.length) return { deviceAlreadyUsed: false };
    return { deviceAlreadyUsed: true, existingAccounts };
  } catch (error) {
    console.error('Error checking device fingerprint:', error);
    return { deviceAlreadyUsed: false };
  }
}

// قائمة الحسابات المشتركة في نفس الجهاز — لعرضها في شاشة الحظر بالواجهة
// فقط. بتتنادى مرة واحدة بس وقت ما نرجّع رد "محظور" فعليًا (نادر)، مش
// على كل طلب عادي.
async function getSharedAccountsForDevice(env, deviceFingerprint, excludeUserId) {
  if (!deviceFingerprint) return [];
  try {
    const usersData = (await dbGet(env, MAG_USERS_PATH)) || {};
    const shared = [];
    for (const [uid, userData] of Object.entries(usersData)) {
      if (String(uid) === String(excludeUserId)) continue;
      if (userData.deviceFingerprint === deviceFingerprint) {
        shared.push({
          telegramId: uid,
          name: userData.firstName || userData.username || 'Unknown',
          username: userData.username || '',
          photoUrl: userData.photoUrl || '',
        });
      }
    }
    return shared;
  } catch (error) {
    console.error('Error fetching shared accounts:', error);
    return [];
  }
}

// بتتنادى مرة واحدة بس، جوه getOrCreateUser فورًا بعد إنشاء حساب جديد
// كليًا. لو بصمة الجهاز دي مستخدمة قبل كده مع حساب تاني، الحساب الجديد
// ده تحديدًا هو اللي بيتحظر (الحساب/الحسابات الأقدم على نفس الجهاز
// بيفضلوا مستثنيين دايمًا لأنهم أصلاً مش هيدخلوا هنا تاني).
async function guardNewAccountDevice(env, userId, deviceFingerprint) {
  if (!deviceFingerprint) return { blocked: false };
  const formatCheck = validateFingerprintFormat(deviceFingerprint);
  if (!formatCheck.valid) return { blocked: false };

  const fingerprintCheck = await checkDeviceFingerprintMultiAccount(env, deviceFingerprint, userId);
  if (!fingerprintCheck.deviceAlreadyUsed) return { blocked: false };

  await applyBlock(env, userId, {
    reason: 'Device multi-account violation - New account detected',
    violation: 'DEVICE_MULTI_ACCOUNT',
    action: 'initializeUser',
    details: `Device fingerprint already used by ${fingerprintCheck.existingAccounts.length} other account(s)`,
    deviceFingerprint,
  });

  return { blocked: true };
}

// بديل مبسّط لـ isReferralEligible القديمة: نفس فحص الحظر بالظبط (قراءة
// واحدة)، مفيش أي مسار fraud_logs/violations منفصل تاني.
async function isReferralEligible(env, telegramId) {
  const blockCheck = await checkUserBlocked(env, telegramId);
  if (blockCheck && blockCheck.isBlocked) {
    return { eligible: false, reason: blockCheck.reason, reasonCode: blockCheck.violation };
  }
  return { eligible: true };
}
// ════════════════════════════════════════════════════════════════════
//  نهاية نظام الحماية ضد تعدد الحسابات
// ════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────
//  CORS Headers
// ──────────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Init-Data, X-Action',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

function ok(data) {
  return json({ success: true, data, serverTime: Date.now() });
}

function fail(error, status = 400) {
  return json({ success: false, error, serverTime: Date.now() }, status);
}

// رد خاص يطلب من الواجهة الأمامية إظهار نافذة كابتشا Cloudflare Turnstile
// قبل إعادة المحاولة (الواجهة تتعرف على requiresCaptcha:true وتفتح النافذة).
function failCaptcha(error) {
  return json({ success: false, error, requiresCaptcha: true, serverTime: Date.now() }, 400);
}

// رد خاص لحساب محظور — الواجهة الأمامية تتعرف على blocked:true فتعرض
// صفحة الحظر المخصصة (Ban Screen) بدلاً من التطبيق الرئيسي، مع سبب الحظر.
function failBlocked(reason, reasonCode, linkedAccounts) {
  return json({
    success: false,
    error: reason || 'This account is banned from using the bot',
    blocked: true,
    reasonCode: reasonCode || 'blocked',
    linkedAccounts: Array.isArray(linkedAccounts) ? linkedAccounts : [],
    serverTime: Date.now(),
  }, 403);
}

// ──────────────────────────────────────────────────────────────────────
//  التحقق من Cloudflare Turnstile (Captcha)
//  يُستدعى قبل صرف مكافأة إعلان (كل N إعلان) أو قبل صرف مكافأة أي لعبة.
// ──────────────────────────────────────────────────────────────────────
// options.expectedHostname: لو موجودة، لازم تساوي data.hostname الراجعة من
// Cloudflare (الدومين اللي اتحل عليه التوكن فعليًا) — بيمنع استخدام توكن
// اتحل على دومين تاني (مثلاً موقع تجريبي بايثون بيقلد الطلب) مع سيرفرنا.
// options.expectedAction: لو موجودة، لازم تساوي data.action الراجعة —
// بيمنع إعادة استخدام توكن اتحل لغرض تاني (زي كابتشا اللعبة) مع مكافأة
// الإعلان، أو العكس. القيمتين دول قبل كده كان الكود بيتجاهلهم تمامًا
// ويتحقق فقط من data.success.
async function verifyTurnstile(token, ip, secretKey, options = {}) {
  const { expectedHostname, expectedAction } = options;
  if (!secretKey) return { success: false, errorCodes: ['not-configured'] };
  if (!token || typeof token !== 'string') return { success: false, errorCodes: ['missing-input-response'] };
  try {
    const form = new URLSearchParams();
    form.set('secret', secretKey);
    form.set('response', token);
    if (ip && ip !== 'unknown') form.set('remoteip', ip);
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.success) {
      return { success: false, errorCodes: data['error-codes'] || [] };
    }
    if (expectedHostname && data.hostname !== expectedHostname) {
      return { success: false, errorCodes: ['hostname-mismatch'], hostname: data.hostname };
    }
    if (expectedAction && data.action !== expectedAction) {
      return { success: false, errorCodes: ['action-mismatch'], action: data.action };
    }
    return { success: true, errorCodes: [] };
  } catch (err) {
    return { success: false, errorCodes: ['internal-error'], error: err.message };
  }
}

// ──────────────────────────────────────────────────────────────────────
//  أدوات مساعدة عامة
// ──────────────────────────────────────────────────────────────────────
function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateReferralCode(telegramId) {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${String(telegramId).slice(-4)}${rand}`.slice(0, 10);
}

// Generates a referral code and verifies it isn't already taken before
// handing it back. The old version never checked for collisions, so two
// users could in rare cases end up sharing the same code, which would make
// referral links silently stop working for one of them (lookups only ever
// return a single match). This retries a few times with a fresh random
// suffix, and falls back to a timestamp-based suffix that's guaranteed
// unique if it somehow still collides after 5 tries.
async function generateUniqueReferralCode(env, telegramId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode(telegramId);
    const lookup = await findUserByReferralCode(env, code);
    if (!lookup.user) return code;
  }
  const uniqueSuffix = Date.now().toString(36).toUpperCase().slice(-6);
  return `${String(telegramId).slice(-4)}${uniqueSuffix}`.slice(0, 10);
}

function todayKeyUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────────────
//  Rate Limiting بسيط بالذاكرة (بحسب IP)
// ──────────────────────────────────────────────────────────────────────
function checkRateLimit(key) {
  const now = Date.now();
  const arr = (rateLimitStore.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX_REQ) {
    rateLimitStore.set(key, arr);
    return false;
  }
  arr.push(now);
  rateLimitStore.set(key, arr);
  return true;
}

function cleanupExpiredHashes() {
  const now = Date.now();
  for (const [hash, exp] of usedInitDataHashes) {
    if (exp < now) usedInitDataHashes.delete(hash);
  }
}

// ──────────────────────────────────────────────────────────────────────
//  التحقق من Telegram WebApp initData (HMAC-SHA256)
// ──────────────────────────────────────────────────────────────────────
async function verifyTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string' || initData.length < 10) {
    return { valid: false, error: 'initData is missing or invalid' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false, error: 'No hash found in initData' };

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || nowSec - authDate > INIT_DATA_MAX_AGE) {
    return { valid: false, error: 'initData has expired (Replay Protection)' };
  }

  try {
    const enc = new TextEncoder();

    const webAppDataKey = await crypto.subtle.importKey(
      'raw',
      enc.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secretKeyBuffer = await crypto.subtle.sign('HMAC', webAppDataKey, enc.encode(botToken));

    const secretKey = await crypto.subtle.importKey(
      'raw',
      secretKeyBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const computedHashBuffer = await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheckString));
    const computedHash = bufferToHex(computedHashBuffer);

    if (computedHash !== hash) {
      return { valid: false, error: 'Invalid initData signature (check that BOT_TOKEN is correct)' };
    }

    cleanupExpiredHashes();
    usedInitDataHashes.set(hash, Date.now() + INIT_DATA_MAX_AGE * 1000);

    const userJson = params.get('user');
    const user = userJson ? JSON.parse(userJson) : null;
    if (!user || !user.id) {
      return { valid: false, error: 'No user data found in initData' };
    }

    // ───── start_param: القيمة دي بتتولّد فقط لو رابط الدعوة كان بصيغة
    // ?startapp=CODE (رابط مباشر لميني أب) — مش ?start=CODE (دي بصيغة
    // بوت تقليدي بترسل رسالة /start للشات ومش بتدخل initData بالمرة) ─────
    return {
      valid: true,
      user,
      startParam: params.get('start_param') || null,
      authDate,
    };
  } catch (err) {
    return { valid: false, error: 'Failed to verify initData: ' + err.message };
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Firebase Realtime Database — REST API Helpers
// ──────────────────────────────────────────────────────────────────────
function dbUrl(env, path) {
  const base = env.FIREBASE_DATABASE_URL.replace(/\/$/, '');
  return `${base}/${path}.json`;
}

async function dbGet(env, path) {
  const res = await fetch(dbUrl(env, path));
  if (!res.ok) throw new Error(`Firebase GET failed (${res.status}) on ${path}`);
  return await res.json();
}

async function dbSet(env, path, value) {
  const res = await fetch(dbUrl(env, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Firebase PUT failed (${res.status}) on ${path}`);
  return await res.json();
}

async function dbUpdate(env, path, value) {
  const res = await fetch(dbUrl(env, path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Firebase PATCH failed (${res.status}) on ${path}`);
  return await res.json();
}

async function dbPush(env, path, value) {
  const res = await fetch(dbUrl(env, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Firebase POST failed (${res.status}) on ${path}`);
  const j = await res.json();
  return j.name;
}

async function dbDelete(env, path) {
  const res = await fetch(dbUrl(env, path), { method: 'DELETE' });
  if (!res.ok) throw new Error(`Firebase DELETE failed (${res.status}) on ${path}`);
}

// ──────────────────────────────────────────────────────────────────────
//  الإعدادات العامة للمشروع (config/) — كل القيم قابلة للتعديل من Firebase
// ──────────────────────────────────────────────────────────────────────
async function getConfig(env) {
  let config = await dbGet(env, 'config');
  if (!config) config = {};

  let changed = false;
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    if (config[k] === undefined) {
      config[k] = v;
      changed = true;
    }
  }

  // ── إعدادات كل شركة إعلانات (config/adCompanies/<company>) ──────────
  // الحلقة اللي فوق بتضيف "adCompanies" كامل مرة واحدة بس لو مش موجود
  // خالص. لكن لو config/adCompanies كان موجود بالفعل من قبل (زي أي
  // مشروع شغّال) وبعدين ضفنا شركة جديدة (زي monetix) في DEFAULT_CONFIG،
  // الحلقة مش هتلاحظها لأن adCompanies نفسه مش undefined. عشان كده هنا
  // بنتأكد إن كل شركة معروفة في DEFAULT_CONFIG.adCompanies موجودة فعليًا
  // كنود مستقل جوه config.adCompanies في Firebase، ولو ناقصة بنضيفها
  // بالقيم الافتراضية ونحفظها — من غير ما نلمس أي شركة موجودة بالفعل
  // (حتى لو قيمها مختلفة عن الافتراضي).
  if (!config.adCompanies || typeof config.adCompanies !== 'object') {
    config.adCompanies = {};
    changed = true;
  }
  for (const [company, defaults] of Object.entries(DEFAULT_CONFIG.adCompanies || {})) {
    if (!config.adCompanies[company] || typeof config.adCompanies[company] !== 'object') {
      config.adCompanies[company] = { ...defaults };
      changed = true;
    } else {
      // النود موجود لكن ممكن ينقصه reward أو dailyLimit بس (مثلًا لو
      // اتضاف يدويًا في Firebase بحقل واحد فقط)، فبنكمل الناقص فقط.
      if (config.adCompanies[company].reward === undefined) {
        config.adCompanies[company].reward = defaults.reward;
        changed = true;
      }
      if (config.adCompanies[company].dailyLimit === undefined) {
        config.adCompanies[company].dailyLimit = defaults.dailyLimit;
        changed = true;
      }
    }
  }

  // اسم البوت ثابت هنا حتى لا تستمر روابط الإحالة في استخدام اسم قديم
  // محفوظ في Firebase أو في متغيرات البيئة.
  if (config.botUsername !== DEFAULT_CONFIG.botUsername) {
    config.botUsername = DEFAULT_CONFIG.botUsername;
    changed = true;
  }
  if (env.BOT_TOKEN && config.botToken !== env.BOT_TOKEN) {
    config.botToken = env.BOT_TOKEN;
    changed = true;
  } else if (config.botToken === undefined) {
    config.botToken = env.BOT_TOKEN || '';
    changed = true;
  }

  if (changed) {
    try {
      await dbSet(env, 'config', config);
    } catch (_) {
      // لو فشل الحفظ، نكمل بالقيم محليًا لهذا الطلب بس بدون ما نوقف السيرفر
    }
  }

  return config;
}

// تثبيت مهام الدعوة الثابتة *فقط لو غير موجودة* — لا يتم لمس أي مهمة
// موجودة بالفعل حتى لو قيمها مختلفة عن القيم الافتراضية في الكود
// (بهذا الشكل تقدر تعدّل reward/title/status لأي مهمة دعوة من Firebase
// وتتأكد إنها هتفضل بنفس القيمة ومش هترجع تتصفّر تلقائيًا)
async function ensureFixedInviteTasks(env) {
  const existing = await dbGet(env, 'tasks');
  const updates = {};
  for (const t of FIXED_INVITE_TASKS) {
    const already = existing && existing[t.id];
    if (!already) {
      updates[t.id] = {
        id: t.id,
        title: t.title,
        link: '',
        reward: t.reward,
        category: 'invite',
        status: 'active',
        requiredReferrals: t.requiredReferrals,
      };
    }
  }
  if (Object.keys(updates).length) {
    await dbUpdate(env, 'tasks', updates);
  }
}

// قنوات الاشتراك الإجباري — تُنشأ بقيمة مبدئية مرة واحدة فقط لو العقدة
// غير موجودة بالمرة في Firebase. لو صاحب المشروع مسح كل القنوات يدويًا
// (عقدة فاضية {}) مش هيتم زرع القناة الافتراضية تاني.
async function getMandatoryChannels(env) {
  let raw = await dbGet(env, 'mandatoryChannels');
  if (raw === null || raw === undefined) {
    const seed = {};
    for (const c of DEFAULT_MANDATORY_CHANNELS) {
      seed[c.id] = { title: c.title, link: c.link, username: c.username, status: c.status };
    }
    await dbSet(env, 'mandatoryChannels', seed);
    raw = seed;
  }
  return Object.entries(raw)
    .map(([id, c]) => ({ id, ...c }))
    .filter((c) => c.status !== 'disabled' && c.status !== 'inactive');
}

// ──────────────────────────────────────────────────────────────────────
//  المنطق الخاص بالمستخدمين
// ──────────────────────────────────────────────────────────────────────
async function getOrCreateUser(env, tgUser, startParam, config, botToken, body) {
  const telegramId = String(tgUser.id);
  let user = await dbGet(env, `users/${telegramId}`);

  if (!user) {
    const referralCode = await generateUniqueReferralCode(env, telegramId);
    // بصمة الجهاز الجاية من الفرونت اند (device-fingerprint.client.js) —
    // بتتخزن كحقل واحد بس جوه المستخدم نفسه، ومفيش أي مسار منفصل تاني
    // (device_links, device_id_map... إلخ اتشالوا بالكامل).
    const deviceFingerprint = (body && typeof body._deviceFingerprint === 'string') ? body._deviceFingerprint : null;
    user = {
      telegramId,
      firstName: tgUser.first_name || '',
      lastName: tgUser.last_name || '',
      username: tgUser.username || '',
      photoUrl: tgUser.photo_url || '',
      languageCode: tgUser.language_code || '',
       balance: 0,
       tonBalance: 0,
      wallet: '',
      referralCode,
      referredBy: null,
      completedTasks: [],
      comboClaimDate: null,
      totalAdsWatched: 0,
      wheelSpinsUsed: 0,
      forceSubPassed: false,
      deviceFingerprint: deviceFingerprint || null,
      createdAt: Date.now(),
      lastLogin: Date.now(),
    };

    await dbSet(env, `users/${telegramId}`, user);

    // ── حماية تعدد الحسابات: بتتفحص مرة واحدة بس هنا، لحظة إنشاء الحساب
    // الجديد فعليًا (وليس على كل طلب بعد كده) — لو الجهاز ده مستخدم قبل
    // كده مع حساب تاني، الحساب الجديد ده تحديدًا هو اللي هيتحظر فورًا
    // (blocks/{telegramId})، والحظر هيتفحص في نقطة الدخول الرئيسية زي
    // أي حساب محظور تاني. ─────────────────────────────────────────────
    if (deviceFingerprint) {
      await guardNewAccountDevice(env, telegramId, deviceFingerprint);
    }

    // تسجيل الإحالة بعد حفظ المستخدم، حتى يمكن إعادة المحاولة أيضًا
    // إذا كان المستخدم قد فتح التطبيق سابقًا بدون رابط دعوة.
    await registerReferralIfNeeded(env, user, startParam, config);

    // لو الاشتراك الإجباري متوقف أو لا توجد قنوات مفعّلة، فعّل الإحالة فورًا
    const fsStatus = await checkUserForceSub(env, telegramId, botToken, config);
    if (fsStatus.passed) {
      await dbUpdate(env, `users/${telegramId}`, { forceSubPassed: true });
      user.forceSubPassed = true;
      await activateReferralIfNeeded(env, telegramId, config, botToken);
    }
  } else {
    user.firstName = tgUser.first_name || user.firstName;
    user.lastName = tgUser.last_name || user.lastName;
    user.username = tgUser.username || user.username;
    user.photoUrl = tgUser.photo_url || user.photoUrl;
    user.languageCode = tgUser.language_code || user.languageCode;
    user.lastLogin = Date.now();
    await dbUpdate(env, `users/${telegramId}`, {
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      photoUrl: user.photoUrl,
      languageCode: user.languageCode,
      lastLogin: user.lastLogin,
    });
    await registerReferralIfNeeded(env, user, startParam, config);
  }

  // دعم حالة المستخدم الموجود مسبقًا: لو استوفى الشروط بالفعل،
  // فعّل الإحالة الجديدة فور تسجيلها.
  if (user.forceSubPassed) {
    await activateReferralIfNeeded(env, user.telegramId, config, botToken);
  }

  return user;
}

async function registerReferralIfNeeded(env, user, startParam, config) {
  const telegramId = String(user.telegramId);

  // ───── تسجيل تشخيصي (Debug) اتلغى بالكامل بناءً على طلبك: مبقاش بيتكتب
  // أي حاجة تحت debug_referral_attempts/<telegramId> في Firebase. الدالة
  // سايبينها كـ no-op (بدل ما نحذف كل نداءاتها من الكود) عشان منضطرش
  // نلمس منطق الإحالة نفسه في الأسفل.
  const logAttempt = async () => {};

  if (!startParam) {
    await logAttempt({ result: 'no_start_param' });
    return;
  }
  if (user.referredBy) {
    await logAttempt({ result: 'already_has_referrer', existingReferrer: user.referredBy });
    return;
  }

  try {
    const referralCode = String(startParam).trim().slice(0, 128);
    if (!referralCode) {
      await logAttempt({ result: 'empty_code_after_trim' });
      return;
    }

    const lookup = await findUserByReferralCode(env, referralCode);
    const referrer = lookup.user;
    if (!referrer) {
      // lookupSource/indexedQueryFailed/fallbackError tell us whether this
      // was a genuine "no such code exists" (source: fallback, having
      // scanned every user) or the lookup itself broke somewhere along the
      // way (indexedQueryFailed / fallback_error) — previously both looked
      // identical in the logs, making real failures indistinguishable from
      // a mistyped or bogus code.
      await logAttempt({
        result: 'referrer_not_found',
        codeSearched: referralCode,
        lookupSource: lookup.source,
        indexedQueryFailed: lookup.indexedQueryFailed,
        indexedQueryError: lookup.indexedQueryError || null,
        fallbackError: lookup.fallbackError || null,
      });
      return;
    }
    if (String(referrer.telegramId) === telegramId) {
      await logAttempt({ result: 'self_referral_blocked', codeSearched: referralCode });
      return;
    }

    const referrerId = String(referrer.telegramId);
    const existingRef = await dbGet(env, `referrals/${referrerId}/${telegramId}`);
    if (!existingRef) {
      const reward = config.referralReward ?? DEFAULT_CONFIG.referralReward;
      // تُسجّل الإحالة pending وتتحول إلى completed مباشرة بعد استيفاء
      // شروط التفعيل (مشاهدة 10 إعلانات) — المكافأة تُصرف مرة واحدة فقط،
      // بدون أي تقسيم على عدة أيام.
      await dbSet(env, `referrals/${referrerId}/${telegramId}`, {
        telegramId,
        firstName: user.firstName,
        username: user.username,
        photoUrl: user.photoUrl,
        joinedAt: Date.now(),
        reward,
        status: 'pending',
      });
      await sendTelegramMessage(env, config.botToken || '', referrerId,
        `👥 New referral joined!\n\n👤 ${user.firstName || user.username || 'A user'} opened Pmt Gram with your link.\n\n⏳ They need to watch 10 ads before you get paid.\n💎 Your reward: +${Number(reward).toLocaleString('en-US')} PMT — credited once, as soon as they finish`);
    }

    user.referredBy = referrerId;
    await dbUpdate(env, `users/${telegramId}`, { referredBy: referrerId });
    await logAttempt({ result: 'linked_ok', referrerId, codeSearched: referralCode });
  } catch (err) {
    // فشل تسجيل الإحالة لا يمنع المستخدم من فتح التطبيق.
    await logAttempt({ result: 'exception', errorMessage: String(err && err.message || err) });
  }
}

// Returns { user, source, indexedQueryFailed, fallbackError }. The "source"
// field tells the caller exactly how the answer was reached, so a
// "not found" result can be told apart from a lookup that actually failed
// (which used to be silently swallowed and looked identical to a genuine
// miss in the debug logs — making real outages impossible to diagnose).
async function findUserByReferralCode(env, code) {
  const base = env.FIREBASE_DATABASE_URL.replace(/\/$/, '');
  const url = `${base}/users.json?orderBy=${encodeURIComponent('"referralCode"')}&equalTo=${encodeURIComponent('"' + code + '"')}`;
  let indexedQueryFailed = false;
  let indexedQueryError = null;

  try {
    const res = await fetch(url);
    if (res.ok) {
      const result = await res.json();
      if (result) {
        const key = Object.keys(result)[0];
        if (key) return { user: result[key], source: 'indexed' };
      }
    } else {
      indexedQueryFailed = true;
      indexedQueryError = `HTTP ${res.status}`;
    }
  } catch (err) {
    indexedQueryFailed = true;
    indexedQueryError = String(err && err.message || err);
  }

  // Fallback in case Firebase rules or a missing index blocked the filtered
  // query above. The user count is normally small enough that scanning the
  // whole table server-side is fine, and this comparison is case-insensitive
  // so a code copied in a different case still matches.
  try {
    const allUsers = await dbGet(env, 'users');
    if (!allUsers) return { user: null, source: 'fallback_no_users', indexedQueryFailed, indexedQueryError };
    const wanted = String(code).trim().toUpperCase();
    const match = Object.values(allUsers).find((u) =>
      String(u?.referralCode || '').trim().toUpperCase() === wanted
    );
    return { user: match || null, source: 'fallback', indexedQueryFailed, indexedQueryError };
  } catch (err) {
    return {
      user: null,
      source: 'fallback_error',
      indexedQueryFailed,
      indexedQueryError,
      fallbackError: String(err && err.message || err),
    };
  }
}

// ───────── إعدادات كل شركة إعلانات على حدة ─────────
// تُقرأ من Firebase تحت config/adCompanies/<company>/{reward, dailyLimit}
// ولو مش موجودة، بترجع للقيم الاحتياطية config/adReward و config/adCompanyDailyLimit.
//
// شركات الإعلانات المسموح بها حصريًا (نفس الـ3 شركات المستخدمة فعليًا في
// الواجهة الأمامية: Adsgram / GigaPub / Monetix). أي اسم شركة تاني بييجي
// في الطلب (بما فيه "monetag" القديمة اللي اتشالت بالكامل) يترفض فورًا
// من canonicalAdCompany (بيرجع null) بدل ما ياخد قيمة افتراضية زي الأول.
// لو حابب تضيف شركة إعلانات جديدة مستقبلًا، أضف اسمها هنا في
// COMPANY_ALIASES وفي DEFAULT_CONFIG.adCompanies فوق.
const COMPANY_ALIASES = {
  adsgram: ['adsgram'],
  gigapub: ['gigapub', 'giga', 'gigapub.tech'],
  monetix: ['monetix', 'monetixads'],
};

// يرجّع الاسم الموحّد للشركة لو كانت واحدة من الشركات المسموح بها فقط،
// وإلا يرجّع null (الاستدعاء المسؤول لازم يتعامل مع null كطلب مرفوض).
function canonicalAdCompany(company) {
  const normalized = String(company || '').trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(COMPANY_ALIASES)) {
    if (aliases.includes(normalized)) return canonical;
  }
  return null;
}

function findCompanyNode(adCompanies, company) {
  if (!adCompanies) return {};

  const canonical = canonicalAdCompany(company);
  if (!canonical) return {};
  const aliases = COMPANY_ALIASES[canonical] || [canonical];
  // 1) تطابق مباشر بالاسم الموحد
  if (adCompanies[canonical]) return adCompanies[canonical];

  // 2) تطابق مع أي alias معروف (بالاسم بالظبط)
  for (const alias of aliases) {
    if (adCompanies[alias]) return adCompanies[alias];
  }

  // 3) تطابق غير حساس لحالة الأحرف/المسافات الزايدة، سواء مع الاسم
  //    الأساسي أو مع أي alias، ضد كل المفاتيح الموجودة فعليًا في Firebase
  const normalizedTargets = aliases.map(a => a.trim().toLowerCase());
  for (const key of Object.keys(adCompanies)) {
    if (normalizedTargets.includes(key.trim().toLowerCase())) {
      return adCompanies[key];
    }
  }

  return {};
}

function getAdCompanyConfig(config, company) {
  const canonical = canonicalAdCompany(company);
  if (!canonical) return { reward: 0, dailyLimit: 0 };
  const perCompany = findCompanyNode(config.adCompanies, canonical);
  const rewardValue = Number(
    perCompany.reward ?? config.adReward ?? DEFAULT_CONFIG.adReward
  );
  const limitValue = Number(
    perCompany.dailyLimit ?? config.adCompanyDailyLimit ?? DEFAULT_CONFIG.adCompanyDailyLimit
  );
  const reward = Number.isFinite(rewardValue) && rewardValue > 0
    ? Math.floor(rewardValue)
    : DEFAULT_CONFIG.adReward;
  const dailyLimit = Number.isFinite(limitValue) && limitValue >= 0
    ? Math.floor(limitValue)
    : DEFAULT_CONFIG.adCompanyDailyLimit;
  return { reward, dailyLimit };
}

// يحول العدادات القديمة إلى الشكل الموحد الذي تعرضه الواجهة.
// لو كانت قاعدة البيانات تحتوي أكثر من alias لنفس الشركة، نستخدم الأكبر
// بدل جمعها حتى لا يتكرر نفس العداد بعد أي ترحيل سابق.
function normalizeAdWatchCounters(rawCounters, legacyTotal = 0) {
  const result = {};
  if (rawCounters && typeof rawCounters === 'object') {
    for (const [key, value] of Object.entries(rawCounters)) {
      const canonical = canonicalAdCompany(key);
      // شركات غير معروفة (زي "monetag" القديمة اللي اتشالت بالكامل) بيتم
      // تجاهلها هنا — عدادها القديم في قاعدة البيانات مش بيتحسب تاني ولا
      // بيتحول لأي شركة تانية.
      if (!canonical) continue;
      const count = Math.max(0, Number(value || 0));
      result[canonical] = Math.max(result[canonical] || 0, count);
    }
  }
  return result;
}

function totalAdWatchCounters(counters) {
  return Object.values(counters || {})
    .reduce((sum, count) => sum + Math.max(0, Number(count || 0)), 0);
}

// يرجّع إعدادات كل الشركات المعروفة بأسماء ثابتة للواجهة.
function getAllAdCompaniesConfig(config) {
  const known = new Set([
    ...Object.keys(DEFAULT_CONFIG.adCompanies || {}),
    'adsgram',
    'gigapub',
    'monetix',
  ]);
  const result = {};
  for (const company of known) {
    result[company] = getAdCompanyConfig(config, company);
  }
  return result;
}

async function incrementBalance(env, telegramId, amount) {
  const user = await dbGet(env, `users/${telegramId}`);
  const newBalance = (user?.balance || 0) + amount;
  await dbUpdate(env, `users/${telegramId}`, { balance: newBalance });
  return newBalance;
}

async function chargeTonBalance(env, telegramId, amount) {
  const user = await dbGet(env, `users/${telegramId}`);
  const balance = Number(user?.tonBalance || 0);
  const charge = Number(amount);
  if (!Number.isFinite(charge) || charge <= 0) {
    return { ok: false, error: 'Invalid TON task price' };
  }
  if (balance < charge) {
    return { ok: false, error: `Insufficient TON balance. You need ${charge.toFixed(4)} TON.` };
  }
  const newBalance = Number((balance - charge).toFixed(4));
  await dbUpdate(env, `users/${telegramId}`, { tonBalance: newBalance });
  await addBalanceLog(env, telegramId, {
    type: 'task_promotion_payment',
    amount: -charge,
    currency: 'TON',
    ts: Date.now(),
  });
  return { ok: true, tonBalance: newBalance };
}

// أقصى عدد سجلات بلانس لوج يتم الاحتفاظ بيها لكل مستخدم. بعد كل عملية
// إضافة، بيتم مسح أي سجلات أقدم من آخر BALANCE_LOG_MAX_ENTRIES تلقائيًا
// (انظر trimBalanceLogs تحت) عشان الحجم في قاعدة البيانات ميكبرش من غير
// حد أقصى مع الوقت.
const BALANCE_LOG_MAX_ENTRIES = 15;

// بتمسح أي سجلات بلانس لوج زيادة عن آخر BALANCE_LOG_MAX_ENTRIES لمستخدم
// معيّن. مفاتيح Firebase push (اللي بيرجّعها dbPush) بترتّب أبجديًا بنفس
// ترتيب الوقت اللي اتكتبت بيه، فبنرتّبها ونمسح الأقدم بس.
async function trimBalanceLogs(env, telegramId, maxEntries = BALANCE_LOG_MAX_ENTRIES) {
  try {
    const all = await dbGet(env, `balanceLogs/${telegramId}`);
    if (!all) return;
    const keys = Object.keys(all).sort();
    if (keys.length <= maxEntries) return;
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map((k) => dbDelete(env, `balanceLogs/${telegramId}/${k}`).catch(() => {})));
  } catch (_) {
    // فشل التنضيف لا يوقف تسجيل الرصيد نفسه.
  }
}

async function addBalanceLog(env, telegramId, logEntry) {
  await dbPush(env, `balanceLogs/${telegramId}`, logEntry);
  await trimBalanceLogs(env, telegramId);

  // عمولة المحيل 10% من أرباح المستخدم المُحال.
  if (Number(logEntry.amount || 0) > 0 &&
       logEntry.type !== 'referral_reward' &&
       logEntry.type !== 'referral_daily_reward' &&
       logEntry.type !== 'referral_commission' &&
      logEntry.type !== 'weekly_referral_contest_prize') {
    try {
      const referredUser = await dbGet(env, `users/${telegramId}`);
      const referrerId = referredUser?.referredBy;
      const referral = referrerId
        ? await dbGet(env, `referrals/${referrerId}/${telegramId}`)
        : null;
      const blockCheck = await checkUserBlocked(env, telegramId);
      const commission = Math.floor(Number(logEntry.amount) * 0.10);
      // العمولة 10% تُستحق بمجرد اكتمال (تفعيل) الإحالة — أي بعد صرف
      // مكافأة الإحالة الفردية (status === 'completed'). النظام القديم
      // القائم على 3 أيام (status === 'active') لم يعد له وجود.
      if (referrerId && referral?.status === 'completed' &&
          Number(referredUser?.totalAdsWatched || 0) >= 10 &&
          !(blockCheck && blockCheck.isBlocked) && commission > 0) {
        await incrementBalance(env, referrerId, commission);
        await dbPush(env, `balanceLogs/${referrerId}`, {
          type: 'referral_commission',
          amount: commission,
          relatedUser: String(telegramId),
          sourceType: logEntry.type || 'earning',
          ts: Date.now(),
        });
        await trimBalanceLogs(env, referrerId);
      }
    } catch (_) {
      // لا نوقف ربح المستخدم إذا تعذر تسجيل العمولة.
    }
  }
}

// تفعيل مكافأة الإحالة للداعي (يُستدعى بعد نجاح المُحال في الاشتراك
// الإجباري — أو فورًا عند إنشاء الحساب لو الاشتراك الإجباري متوقف).
// ملحوظة مهمة: حتى لو الشرط ده اتحقق، المكافأة (والحالة "active" في
// القايمة) متترصدش إلا بعد ما المُحال يشوف 10 إعلانات فعليًا
// (totalAdsWatched >= 10). ده مش باج — ده إجراء مقصود ضد الاحتيال.
// لو حابب تغيّر العدد أو تلغي الشرط، عدّل الرقم 10 هنا وفي
// handleGetState (سطر فيه adsRequired: 10).
async function sendTelegramMessage(env, botToken, chatId, text) {
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text }),
    });
  } catch (_) {}
}

// مكافأة الإحالة: نظام يوم واحد فقط. بمجرد ما المُحال يشوف 10 إعلانات
// (في أي يوم)، تُصرف مكافأة الإحالة للمُحيل مباشرة ومرة واحدة فقط —
// لا يوجد أي تقسيم للمكافأة على عدة أيام بعد الآن.
async function activateReferralIfNeeded(env, telegramId, config, botToken) {
  // اتلغى بالكامل بناءً على طلبك: مبقاش بيتكتب أي حاجة تحت
  // debug_referral_activation/<telegramId> في Firebase.
  const logActivation = async () => {};

  const user = await dbGet(env, `users/${telegramId}`);
  if (!user || !user.referredBy) {
    await logActivation({ result: 'no_user_or_no_referrer' });
    return;
  }
  const referrerId = user.referredBy;
  const refRecord = await dbGet(env, `referrals/${referrerId}/${telegramId}`);
  if (!refRecord) {
    await logActivation({ result: 'no_referral_record_found', referrerId });
    return;
  }

  // ── منع الاستغلال (Anti-Abuse) — الخط الأول: مكافأة الإحالة تُصرف
  // مرة واحدة فقط لكل إحالة مدى الحياة. أي إحالة وصلت لحالة 'completed'
  // (سواء من النظام الجديد، أو من نظام الـ3 أيام القديم بعد اكتمال آخر
  // يوم فيه) تتوقف هنا فورًا ولا تُعاد معالجتها إطلاقًا. ──────────────
  if (refRecord.status === 'completed') {
    await logActivation({ result: 'already_claimed' });
    return;
  }

  const today = todayKeyCairo();
  const watched = user.adWatchDate === today ? Number(user.adsWatchedToday || 0) : 0;
  if (watched < 10) {
    await logActivation({ result: 'not_enough_ads_yet', watched });
    return;
  }

  // ── فحص أهلية مكافأة الإحالة (Anti-Fraud) ──────────────────────
  const refEligibility = await isReferralEligible(env, telegramId);
  if (!refEligibility.eligible) {
    // الحساب يعمل عادي لكن من غير مكافأة إحالة — مفيش أي مسار fraud_logs
    // منفصل بيتكتب فيه دلوقتي (اتشال بالكامل).
    await logActivation({ result: 'blocked_anti_fraud', referrerId, reason: refEligibility.reason });
    return;
  }
  // ─────────────────────────────────────────────────────────────────

  // ── منع الاستغلال — الخط الثاني: نعيد قراءة السجل مباشرة قبل الكتابة
  // ونحدّثه لحالة 'completed' فورًا قبل إضافة الرصيد، عشان نقلّل أقصى
  // ما يمكن نافذة أي طلبين متزامنين (race condition) يحاولان صرف نفس
  // المكافأة مرتين في نفس اللحظة. ──────────────────────────────────
  const freshRecord = await dbGet(env, `referrals/${referrerId}/${telegramId}`);
  if (!freshRecord || freshRecord.status === 'completed') {
    await logActivation({ result: 'already_claimed_race', referrerId });
    return;
  }
  const reward = Number(freshRecord.reward ?? config.referralReward ?? DEFAULT_CONFIG.referralReward);
  await dbUpdate(env, `referrals/${referrerId}/${telegramId}`, {
    status: 'completed',
    adsWatchedAtClaim: watched,
    activatedAt: Date.now(),
    claimedAt: Date.now(),
    rewardPaid: reward,
  });

  const newBalance = await incrementBalance(env, referrerId, reward);
  await addBalanceLog(env, referrerId, {
    type: 'referral_reward',
    amount: reward,
    relatedUser: telegramId,
    ts: Date.now(),
  });
  const referralName = user.firstName || user.username || 'Your referral';
  const activationMessage = `🎉 Referral activated!\n\n👤 ${referralName} watched 10 ads and is now active.\n\n💎 +${reward.toLocaleString('en-US')} PMT credited 💰 Balance: ${Number(newBalance || 0).toLocaleString('en-US')} PMT\n\n📈 You also earn 10% of everything they make, forever.`;
  await sendTelegramMessage(env, botToken, referrerId, activationMessage);
  await logActivation({ result: 'reward_credited', referrerId, reward });
}

// ──────────────────────────────────────────────────────────────────────
//  نظام الكومبو اليومي (Daily Combo)
// ──────────────────────────────────────────────────────────────────────
function simpleHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

async function getOrCreateTodayCombo(env, config) {
  const dateKey = todayKeyUTC();
  let combo = await dbGet(env, `combo/${dateKey}`);
  if (combo) return combo;

  const seed = simpleHash(dateKey + (config.botToken || 'seed'));
  const rand = seededRandom(seed);
  const pool = [...COMBO_EMOJI_POOL];
  const correct = [];
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(rand() * pool.length);
    correct.push(pool.splice(idx, 1)[0]);
  }

  combo = {
    date: dateKey,
    items: correct,
    reward: config.comboReward ?? DEFAULT_CONFIG.comboReward,
    createdAt: Date.now(),
  };
  await dbSet(env, `combo/${dateKey}`, combo);
  return combo;
}

// ──────────────────────────────────────────────────────────────────────
//  عجلة الحظ (Lucky Wheel)
// ──────────────────────────────────────────────────────────────────────

// اختيار قطاع عشوائي من عجلة الحظ بحسب الأوزان (weight) المحددة لكل قطاع
function pickWheelSegmentIndex() {
  const total = WHEEL_SEGMENTS.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (let i = 0; i < WHEEL_SEGMENTS.length; i++) {
    r -= WHEEL_SEGMENTS[i].weight;
    if (r <= 0) return i;
  }
  return WHEEL_SEGMENTS.length - 1;
}

// عدد اللفات المتاحة حاليًا = (عدد الإحالات النشطة ÷ 2) − عدد اللفات
// المستخدمة من قبل. لا يمكن أن يكون سالبًا.
function computeSpinsAvailable(activeReferralsCount, spinsUsed) {
  const earned = Math.floor((activeReferralsCount || 0) / WHEEL_REFERRALS_PER_SPIN);
  return Math.max(0, earned - (spinsUsed || 0));
}

// ──────────────────────────────────────────────────────────────────────
//  نظام التحقق من المهام / الاشتراك الإجباري عبر Telegram Bot API
// ──────────────────────────────────────────────────────────────────────
function extractChatIdentifier(link) {
  if (!link) return null;
  const match = link.match(/t\.me\/([A-Za-z0-9_]+)/);
  return match ? `@${match[1]}` : null;
}

async function checkTelegramMembership(env, chatLink, telegramId, botToken) {
  const chatId = extractChatIdentifier(chatLink);
  if (!chatId || !botToken) return false;

  const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${telegramId}`;
  try {
    const res = await fetch(url);
    const result = await res.json();
    if (!result.ok || !result.result?.user) return false;
    if (String(result.result.user.id) !== String(telegramId)) return false;
    const member = result.result;
    const status = member.status;
    // "restricted" is valid only when Telegram says the user is still a member.
    return ['member', 'administrator', 'creator'].includes(status) ||
      (status === 'restricted' && member.is_member === true);
  } catch (_) {
    return false;
  }
}

async function checkBotAdminInChat(chatLink, botToken) {
  const chatId = extractChatIdentifier(chatLink);
  if (!chatId || !botToken) {
    return { ok: false, error: 'Use a public Telegram channel link such as https://t.me/yourchannel.' };
  }
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const me = await meRes.json();
    if (!me.ok || !me.result?.id) {
      return { ok: false, error: 'Unable to verify the bot account.' };
    }
    const memberRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${me.result.id}`
    );
    const member = await memberRes.json();
    const status = member.ok ? member.result?.status : null;
    if (['administrator', 'creator'].includes(status)) {
      return { ok: true, status };
    }
    return {
      ok: false,
      error: 'Please add the bot as an administrator in your channel, then try again.',
    };
  } catch (_) {
    return { ok: false, error: 'Unable to verify the bot permissions in this channel.' };
  }
}

// التحقق الحقيقي (Live) من انضمام المستخدم لكل قنوات الاشتراك الإجباري
// عبر Telegram Bot API (getChatMember) — وليس مجرد ادعاء من الواجهة
async function checkUserForceSub(env, telegramId, botToken, config) {
  const enabled = config.mandatorySubEnabled !== false;
  const channels = enabled ? await getMandatoryChannels(env) : [];

  if (!enabled || channels.length === 0) {
    return { required: false, passed: true, channels: [] };
  }

  const results = [];
  let allJoined = true;
  for (const ch of channels) {
    const joined = await checkTelegramMembership(env, ch.link, telegramId, botToken);
    if (!joined) allJoined = false;
    results.push({
      id: ch.id,
      title: ch.title || ch.username || extractChatIdentifier(ch.link) || ch.link,
      link: ch.link,
      joined,
    });
  }
  return { required: true, passed: allJoined, channels: results };
}

// ──────────────────────────────────────────────────────────────────────
//  Input Validation Helpers
// ──────────────────────────────────────────────────────────────────────
function isNonEmptyString(v, maxLen = 500) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function isValidUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// تحقق من شكل عنوان محفظة BEP-20 (شبكة BNB Smart Chain هي الشبكة التي
// تعمل عليها عملة SHIBA المستخدمة في هذا البوت للسحب) — صيغة Ethereum-style:
// 0x ثم 40 حرف Hexadecimal (42 حرف بالكامل)
function isValidBep20Address(addr) {
  if (typeof addr !== 'string') return false;
  const v = addr.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}

// ════════════════════════════════════════════════════════════════════
//  معالجات الـ API (Route Handlers)
// ════════════════════════════════════════════════════════════════════

// ───────────────────────── POST /getState ─────────────────────────
async function handleGetState(env, ctx) {
  const { config, botToken } = ctx;
  // اقرأ المستخدم مرة أخرى عند فتح الصفحة. ctx.user تم تحميله قبل بعض
  // عمليات التهيئة، وقد يكون أقدم من القيمة الموجودة فعليًا في Firebase
  // (خصوصًا بعد مشاهدة إعلان من جلسة أخرى).
  const user = await dbGet(env, `users/${ctx.user.telegramId}`).catch(() => ctx.user);
  const telegramId = user.telegramId;

  const [tasksRaw, completedRaw, referralsRaw, logsRaw, withdrawalsRaw, gamePlaysRaw] = await Promise.all([
    dbGet(env, 'tasks'),
    dbGet(env, `users/${telegramId}/completedTasks`),
    dbGet(env, `referrals/${telegramId}`),
    dbGet(env, `balanceLogs/${telegramId}`),
    dbGet(env, `withdrawals/${telegramId}`),
    dbGet(env, `gamePlays/${telegramId}/${todayKeyCairo()}`),
  ]);

  // ───── إعادة التحقق الفعلي (Live) من الاشتراك الإجباري في كل مرة يفتح
  // فيها المستخدم الويب أب — وليس فقط أول مرة. لو ترك القنوات بعد أن كان
  // قد اشترك سابقًا، يُعاد قفل الواجهة حتى يرجع ويشترك من جديد ─────
  const fsStatus = await checkUserForceSub(env, telegramId, botToken, config);
  if (fsStatus.passed !== !!user.forceSubPassed) {
    await dbUpdate(env, `users/${telegramId}`, { forceSubPassed: fsStatus.passed });
    user.forceSubPassed = fsStatus.passed;
  }
  if (fsStatus.passed) {
    await activateReferralIfNeeded(env, telegramId, config, botToken);
  }

  const tasks = tasksRaw
    ? Object.entries(tasksRaw).map(([id, t]) => ({ id, ...t })).filter((t) => t.status === 'active' && t.category !== 'invite')
    : [];

  const completedTasks = completedRaw ? Object.keys(completedRaw) : [];

  // نظام يوم واحد فقط: كل إحالة إما 'pending' (لسه ما شافتش 10 إعلانات)
  // أو 'completed' (اتصرفت مكافأتها بالكامل مرة واحدة). سجلات قديمة من
  // نظام الـ3 أيام السابق ممكن يكون عندها status = 'active' لو كانت
  // لسه مادفعتش كل الأيام — دي بتتعامل هنا كـ 'completed' لأن مكافأتها
  // اتصرفت بالفعل (جزئيًا على الأقل) تحت المنطق القديم.
  const referrals = referralsRaw
    ? await Promise.all(Object.entries(referralsRaw).map(async ([id, r]) => {
        const [referredUser, blocked, referredLogs] = await Promise.all([
          dbGet(env, `users/${id}`).catch(() => null),
          dbGet(env, `${MAG_BLOCKS_PATH}/${id}`).catch(() => null),
          dbGet(env, `balanceLogs/${id}`).catch(() => null),
        ]);
        const adsWatched = Number(referredUser?.totalAdsWatched || 0);
        const logs = referredLogs ? Object.values(referredLogs) : [];
        const totalEarned = logs
          .filter((l) => Number(l.amount || 0) > 0 && l.type !== 'referral_commission')
          .reduce((sum, l) => sum + Number(l.amount || 0), 0);
        const referrerEarned = logsRaw
          ? Object.values(logsRaw)
              .filter((l) => l.type === 'referral_commission' && String(l.relatedUser) === String(id))
              .reduce((sum, l) => sum + Number(l.amount || 0), 0)
          : 0;
        const status = (r.status === 'active' || r.status === 'completed') ? 'completed' : 'pending';
        // مكافأة الإحالة تُصرف مرة واحدة فقط — إما اتصرفت بالكامل
        // (completed) أو لسه (pending) وبالتالي = 0.
        const referralRewardEarned = status === 'completed'
          ? Number(r.rewardPaid ?? r.reward ?? 0)
          : 0;
        const fraudMultipleAccounts = !!blocked;
        return {
          id,
          ...r,
          firstName: referredUser?.firstName || r.firstName || '',
          lastName: referredUser?.lastName || '',
          username: referredUser?.username || r.username || '',
          photoUrl: referredUser?.photoUrl || r.photoUrl || '',
          status,
          adsWatched,
          adsRequired: 10,
          adsRemaining: Math.max(0, 10 - adsWatched),
          totalEarned,
          referrerEarned,
          referralRewardEarned,
          totalReferralEarned: referralRewardEarned + referrerEarned,
          fraudMultipleAccounts,
          fraudReason: blocked?.reason || '',
        };
      }))
    : [];

  const balanceLogs = logsRaw
    ? Object.entries(logsRaw).map(([id, l]) => ({ id, ...l })).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 30)
    : [];

  const today = todayKeyCairo();
  const allLogsForStats = logsRaw
    ? Object.values(logsRaw)
    : [];
  const todayLogs = allLogsForStats.filter((l) => {
    if (l.date === today) return true;
    return l.ts && todayKeyCairoFromTimestamp(l.ts) === today;
  });
  const dailyBonusClaimed = user.dailyBonusDate === today;
  const adsByCompany = user.adWatchDate === today
    ? normalizeAdWatchCounters(user.adsWatchedByCompany, user.adsWatchedToday)
    : {};
  const adsWatchedToday = totalAdWatchCounters(adsByCompany);
  const adCompaniesConfig = getAllAdCompaniesConfig(config);
  const adCompanyDailyLimit = Number(config.adCompanyDailyLimit ?? DEFAULT_CONFIG.adCompanyDailyLimit);
  const earnedToday = todayLogs
    .filter((l) => (parseFloat(l.amount) || 0) > 0)
    .reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);

  const withdrawals = withdrawalsRaw
    ? Object.entries(withdrawalsRaw).map(([id, w]) => ({ id, ...w })).sort((a, b) => (b.ts || 0) - (a.ts || 0))
    : [];

  // لا نرسل botToken أو turnstileSecretKey للواجهة الأمامية أبدًا — بيانات حساسة سيرفر فقط
  const clientConfig = { ...config };
  delete clientConfig.botToken;
  delete clientConfig.turnstileSecretKey;

   const activeReferralsCount = referrals.filter((r) => (r.status === 'active' || r.status === 'completed')).length;
  const wheelSpinsUsed = user.wheelSpinsUsed || 0;
  const wheelSpinsAvailable = computeSpinsAvailable(activeReferralsCount, wheelSpinsUsed);

  return ok({
    user: { ...user, completedTasks },
    balance: user.balance || 0,
    tasks,
    completedTasks,
    referrals,
    balanceLogs,
    withdrawals,
    config: clientConfig,
    mining: {
      startedAt: Number(user.miningStartedAt || 0) || null,
      reward: Number(config.miningReward ?? DEFAULT_CONFIG.miningReward),
      durationMs: Number(config.miningDurationMs ?? DEFAULT_CONFIG.miningDurationMs),
    },
    tonBalance: Number(user.tonBalance || 0),
    wheel: {
      segments: WHEEL_SEGMENTS.map((s) => s.reward),
      spinsAvailable: wheelSpinsAvailable,
      spinsUsed: wheelSpinsUsed,
      referralsPerSpin: WHEEL_REFERRALS_PER_SPIN,
    },
    daily: {
      reward: config.dailyBonusReward ?? DEFAULT_CONFIG.dailyBonusReward,
      claimed: dailyBonusClaimed,
    },
    stats: {
      adsWatchedToday,
      adsWatchedByCompany: adsByCompany,
      adCompanies: adCompaniesConfig,   // { adsgram: {reward, dailyLimit}, gigapub: {...}, monetix: {...} } لكل شركة
      adCompanyDailyLimit,
      adDailyTotalLimit: Number(config.adDailyLimit ?? DEFAULT_CONFIG.adDailyLimit),
      statsDate: today,
      friendsInvited: referrals.length,
      earnedToday,
    },
    gamePlays: gamePlaysRaw || {},
    referralStats: {
      total: referrals.length,
      active: activeReferralsCount,
     inactive: referrals.filter((r) => r.status !== 'completed' && !r.fraudMultipleAccounts).length,
      multipleAccounts: referrals.filter((r) => r.fraudMultipleAccounts).length,
      commissionEarned: referrals.reduce((sum, r) => sum + Number(r.referrerEarned || 0), 0),
    },
    forceSub: {
      required: fsStatus.required,
      passed: fsStatus.passed,
      channels: fsStatus.channels.map((c) => ({
        id: c.id,
        title: c.title,
        link: c.link,
      })),
    },
  });
}

function todayKeyUTCFromTimestamp(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function todayKeyCairo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function todayKeyCairoFromTimestamp(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Number(ts)));
}

// ───────────────────────── POST /heartbeat ─────────────────────────
// الفرونت إند بيبعت الطلب ده كل 25 ثانية (startHeartbeat) عشان يعلّم إن
// المستخدم "أونلاين" دلوقتي. مكانش فيه راوت مسجَّل لـ /heartbeat أصلًا،
// فكان بيرجع 404 كل شوية في الـ Console. مجرد تحديث بسيط لوقت آخر ظهور،
// من غير أي منطق تاني (مفيش مكافآت هنا).
async function handleHeartbeat(env, ctx) {
  const { user } = ctx;
  await dbUpdate(env, `users/${user.telegramId}`, { lastActiveAt: Date.now() });
  return ok({ ok: true });
}

async function handleClaimDailyBonus(env, ctx) {
  const { user, config } = ctx;
  const telegramId = user.telegramId;
  const dateKey = todayKeyCairo();
  const freshUser = await dbGet(env, `users/${telegramId}`);
  if (freshUser?.dailyBonusDate === dateKey) {
    return fail("Daily bonus already claimed");
  }
  const reward = Number(config.dailyBonusReward ?? DEFAULT_CONFIG.dailyBonusReward);
  const newBalance = await incrementBalance(env, telegramId, reward);
  await dbUpdate(env, `users/${telegramId}`, { dailyBonusDate: dateKey });
  await addBalanceLog(env, telegramId, { type: 'daily_bonus', amount: reward, date: dateKey, ts: Date.now() });
  return ok({ shibaBalance: newBalance, shibaAdded: reward, date: dateKey });
}

// أكواد الاستبدال تُدار من Firebase تحت redeemCodes/{CODE}.
// مثال: { reward: 2500, active: true, maxUses: 100, usedCount: 0, expiresAt: 0 }
async function handleRedeemCode(env, ctx) {
  const { user, body } = ctx;
  const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 64);
  if (!code) return fail('Enter a valid code');
  const codePath = `redeemCodes/${code}`;
  const record = await dbGet(env, codePath);
  if (!record || record.active === false) return fail('Code not found');
  if (record.expiresAt && Date.now() > Number(record.expiresAt)) return fail('This code has expired');
  const maxUses = Number(record.maxUses || 0);
  if (maxUses > 0 && Number(record.usedCount || 0) >= maxUses) return fail('Code fully redeemed');
  const userUsePath = `redeemCodeUses/${user.telegramId}/${code}`;
  if (await dbGet(env, userUsePath)) return fail("Code already used");
  const reward = Math.floor(Number(record.reward));
  if (!Number.isFinite(reward) || reward <= 0) return fail('Invalid code value');
  const newBalance = await incrementBalance(env, user.telegramId, reward);
  await dbSet(env, userUsePath, { reward, redeemedAt: Date.now() });
  await dbUpdate(env, codePath, { usedCount: Number(record.usedCount || 0) + 1 });
  await addBalanceLog(env, user.telegramId, { type: 'redeem_code', amount: reward, code, ts: Date.now() });
  return ok({ shibaBalance: newBalance, shibaAdded: reward });
}

// ───────────────────────── POST /startAdView ───────────────────────────
// يُستدعى من الواجهة *قبل* عرض إعلان أي شركة (Adsgram/GigaPub/Monetix)،
// ويرجّع "adTicket" (توكن عشوائي وحيد الاستخدام، صالح لمدة AD_NONCE_TTL_MS
// فقط) مربوط بـ telegramId + company + بصمة الجهاز الحالية. /claimAdReward
// بعد كده يرفض أي طلب مايبقاش معاه adTicket صالح ومطابق — فمينفعش أي
// سكريبت/بوت بايثون ينادي claimAdReward مباشرة من غير ما يمر على الإندبوينت
// ده الأول (ومينفعش يعيد استخدام نفس التذكرة مرتين).
async function handleStartAdView(env, ctx) {
  const { user, config, body } = ctx;
  const company = canonicalAdCompany(body.company);
  // أي اسم شركة غير Adsgram/GigaPub/Monetix يترفض فورًا (لا يُعطى أي
  // قيمة افتراضية زي ما كان بيحصل قبل كده مع monetag).
  if (!company) {
    return fail('Unsupported ad company');
  }
  const companyConfig = getAdCompanyConfig(config, company);

  // فحص مبدئي للحدود اليومية (نفس فحص claimAdReward) — مجرد رفض مبكر
  // عشان مانديش تذكرة لطلب مستحيل يتصرف أصلًا؛ claimAdReward بيعيد
  // نفس الفحص ببيانات محدثة قبل أي صرف فعلي.
  const today = todayKeyCairo();
  const freshUser = await dbGet(env, `users/${user.telegramId}`);
  const byCompany = freshUser?.adWatchDate === today
    ? normalizeAdWatchCounters(freshUser.adsWatchedByCompany, freshUser.adsWatchedToday)
    : {};
  const watched = Number(byCompany[company] || 0);
  if (companyConfig.dailyLimit > 0 && watched >= companyConfig.dailyLimit) {
    return fail('Daily ad limit reached for this company');
  }
  const totalWatchedToday = totalAdWatchCounters(byCompany);
  const overallDailyLimit = Number(config.adDailyLimit ?? DEFAULT_CONFIG.adDailyLimit);
  if (overallDailyLimit > 0 && totalWatchedToday >= overallDailyLimit) {
    return fail('Daily ad limit reached');
  }

  cleanupExpiredAdNonces();
  const fp = afSanitiseKey(body._deviceFingerprint, 64) || 'missing';
  const ticket = generateAdTicket();
  const issuedAt = Date.now();
  adNonceStore.set(ticket, {
    telegramId: String(user.telegramId),
    company,
    fingerprint: fp,
    issuedAt,
    expireAt: issuedAt + AD_NONCE_TTL_MS,
    claiming: false,
    pulses: [],          // [{code, issuedAt}] — سلسلة النبضات أثناء المشاهدة (انظر تعليق AD_PULSE_COUNT فوق)
  });

  return ok({ sid: ticket, expiresInMs: AD_NONCE_TTL_MS, company });
}

// ─────────────────────── POST /sessionSync ───────────────────────────
// اسم الإندبوينت واسماء الحقول هنا مقصود تكون عامة/مبهمة (sid/p/n) عشان
// أي حد بيحلل الـ Network tab ميلاقيش اسم واضح زي "adPulse/adHeartbeat"
// يدله على إن ده بروتوكول تحقق من مشاهدة إعلان حقيقية. المنطق الفعلي:
// نداء متكرر كل ~2 ثانية طول مدة عرض الإعلان، كل نداء لازم يرجّع فيه
// آخر كود اتبعت في النداء اللي فات (p) عشان ياخد الكود الجديد (n).
async function handleSessionSync(env, ctx) {
  const { user, body } = ctx;
  cleanupExpiredAdNonces();

  const sid = String(body.sid || '');
  const record = sid ? adNonceStore.get(sid) : null;
  const fp = afSanitiseKey(body._deviceFingerprint, 64) || 'missing';

  if (!record) {
    return fail('Session expired or invalid', 400);
  }
  if (record.telegramId !== String(user.telegramId) || record.fingerprint !== fp) {
    return fail('Session does not match this request', 400);
  }

  const prev = typeof body.p === 'string' ? body.p : '';
  const pulses = record.pulses || (record.pulses = []);

  if (pulses.length >= AD_PULSE_COUNT) {
    return fail('Session already complete', 400);
  }

  const lastCode = pulses.length ? pulses[pulses.length - 1].code : '';
  const lastAt = pulses.length ? pulses[pulses.length - 1].issuedAt : record.issuedAt;

  // أول نداء: مفيش p سابق. أي نداء بعد كده لازم يرجّع بالظبط آخر كود
  // اتصدر — أي قيمة تانية (سواء فاضية أو غلط أو كود قديم اتكرر) دليل
  // واضح إن في سكريبت بيحاول يخمن/يعيد التسلسل من غير ما يتبع النداءات
  // الحقيقية بترتيبها، فالطلب يترفض فورًا (بدون حظر الحساب).
  if (pulses.length === 0) {
    if (prev) {
      return rejectAdPulseError(env, user.telegramId, 'ad_pulse_unexpected');
    }
  } else if (prev !== lastCode) {
    return rejectAdPulseError(env, user.telegramId, 'ad_pulse_mismatch');
  }

  const now = Date.now();
  const gap = now - lastAt;
  if (gap < AD_PULSE_MIN_GAP_MS) {
    // أسرع من المعقول لواجهة حقيقية بتستنى ~2 ثانية — رفض عادي (مش حظر)
    // لأن ممكن يكون تكرار طلب شبكي عادي (retry).
    return fail('Too fast', 429);
  }
  if (gap > AD_PULSE_MAX_GAP_MS) {
    // اتأخر كتير — السلسلة تعتبر باظت، الكلاينت المفروض يبدأ تذكرة جديدة.
    return fail('Session timed out', 400);
  }

  const code = generatePulseCode();
  pulses.push({ code, issuedAt: now });
  return ok({ n: code, left: AD_PULSE_COUNT - pulses.length });
}

async function handleClaimAdReward(env, ctx) {
  const { user, config, body } = ctx;
  const company = canonicalAdCompany(body.company);
  // نفس القيد الموجود في /startAdView: أي شركة غير الثلاث المسموح بها
  // (Adsgram/GigaPub/Monetix) يترفض طلبها هنا فورًا.
  if (!company) {
    return fail('Unsupported ad company');
  }

  // ── التحقق من تذكرة مشاهدة الإعلان (sid) ────────────────────────
  // لازم تكون اتولّدت من /checkSession قبل كده لنفس telegramId/الشركة/بصمة
  // الجهاز، ولسه صالحة (متعدتش AD_NONCE_TTL_MS)، ومتستخدمتش قبل كده.
  // من هنا لحد النهاية: أي خطأ في البيانات المُرسلة (تذكرة غلط/منتهية/
  // مش مطابقة، وقت مشاهدة مستحيل، أكواد نبض غلط أو ناقصة) = رفض الطلب
  // الحالي فقط (بدون حظر الحساب) — المستخدم يقدر يعيد المحاولة بمشاهدة
  // إعلان جديد من البداية.
  cleanupExpiredAdNonces();
  const ticket = String(body.sid || '');
  const record = ticket ? adNonceStore.get(ticket) : null;
  const fp = afSanitiseKey(body._deviceFingerprint, 64) || 'missing';

  if (!record) {
    return rejectAdPulseError(env, user.telegramId, 'ad_ticket_missing');
  }
  if (record.claiming) {
    // نفس التذكرة مستخدمة حاليًا في طلب تاني شغال (منع إعادة الاستخدام
    // المتزامن/Race Condition) — مش خطأ عادي، ده مؤشر تلاعب واضح.
    return rejectAdPulseError(env, user.telegramId, 'ad_ticket_concurrent');
  }
  if (record.expireAt < Date.now()) {
    adNonceStore.delete(ticket);
    return rejectAdPulseError(env, user.telegramId, 'ad_ticket_expired');
  }
  if (record.telegramId !== String(user.telegramId) || record.company !== company || record.fingerprint !== fp) {
    // التذكرة موجودة لكن مش لنفس المستخدم/الشركة/الجهاز اللي اتولّدت له
    return rejectAdPulseError(env, user.telegramId, 'ad_ticket_mismatch');
  }

  // ── الحد الأدنى للوقت بين بداية الإعلان والمطالبة بالمكافأة ──────────
  // لو الطلب وصل أسرع من adMinWatchMs من وقت /checkSession، معناها
  // الإعلان اتقفل بدري (سواء المستخدم قفله فعلًا أو الإعلان نفسه كان
  // قصير من الأساس). ده مش دليل تلاعب في حد ذاته — فبنرجّع فشل عادي
  // برسالة واضحة للمستخدم بدل ما نحظر الحساب، وهو يقدر يعيد المحاولة
  // بإعلان تاني.
  const minWatchMs = Math.max(0, Number(config.adMinWatchMs ?? DEFAULT_CONFIG.adMinWatchMs ?? 5000));
  if (minWatchMs > 0 && Date.now() - record.issuedAt < minWatchMs) {
    const minWatchSeconds = Math.ceil(minWatchMs / 1000);
    return fail(`Please stay on the ad for at least ${minWatchSeconds} seconds to earn the reward`, 400);
  }

  // ── التحقق من سلسلة النبضات (chk) اللي اتجمعت أثناء المشاهدة ─────────
  // الكلاينت بيرفق كل الأكواد اللي فعلًا استلمها من /sessionSync بالظبط
  // وبنفس الترتيب، بالإضافة للتيكيت الأساسي وطابع زمني (ct). العدد نفسه
  // مش لازم يبقى ثابت (AD_PULSE_COUNT) — إعلانات أقصر من 5 ثواني ممكن
  // منطقيًا متلحقش تجمع كل النبضات، فبنقبل أي عدد حقيقي بدءًا من
  // AD_PULSE_MIN_REQUIRED. لكن أي قيمة غلط أو مكررة أو عدد أكبر مما
  // اتجمع فعلًا = دليل تلاعب واضح فالطلب يترفض فورًا (بدون حظر الحساب).
  const pulses = record.pulses || [];
  const chk = Array.isArray(body.chk) ? body.chk.map((v) => String(v || '')) : [];
  const clientTs = Number(body.ct);

  if (pulses.length < AD_PULSE_MIN_REQUIRED) {
    return rejectAdPulseError(env, user.telegramId, 'ad_pulse_incomplete');
  }
  if (!Number.isFinite(clientTs)) {
    return rejectAdPulseError(env, user.telegramId, 'ad_claim_malformed');
  }
  if (chk.length < AD_PULSE_MIN_REQUIRED || chk.length > pulses.length) {
    return rejectAdPulseError(env, user.telegramId, 'ad_pulse_claim_length');
  }
  const uniqueChk = new Set(chk);
  if (uniqueChk.size !== chk.length) {
    // قيم مكررة داخل نفس الطلب — مش ممكن يحصل مع نداءات حقيقية متتالية
    return rejectAdPulseError(env, user.telegramId, 'ad_pulse_claim_duplicate');
  }
  for (let i = 0; i < chk.length; i++) {
    if (chk[i] !== pulses[i].code) {
      return rejectAdPulseError(env, user.telegramId, 'ad_pulse_claim_mismatch');
    }
  }

  // قفل التذكرة فورًا (Sync، قبل أي await) عشان لو نفس التذكرة اتبعتت في
  // طلبين متوازيين، الطلب التاني يترفض فورًا بدل ما ياخد المكافأة مرتين.
  record.claiming = true;

  try {
    const today = todayKeyCairo();
    const freshUser = await dbGet(env, `users/${user.telegramId}`);
    const companyConfig = getAdCompanyConfig(config, company);
    const limit = companyConfig.dailyLimit;
    const byCompany = freshUser?.adWatchDate === today
      ? normalizeAdWatchCounters(freshUser.adsWatchedByCompany, freshUser.adsWatchedToday)
      : {};
    const watched = Number(byCompany[company] || 0);
    if (limit > 0 && watched >= limit) {
      adNonceStore.delete(ticket);
      return fail('Daily ad limit reached for this company');
    }
    const totalWatchedToday = totalAdWatchCounters(byCompany);
    const overallDailyLimit = Number(config.adDailyLimit ?? DEFAULT_CONFIG.adDailyLimit);
    if (overallDailyLimit > 0 && totalWatchedToday >= overallDailyLimit) {
      adNonceStore.delete(ticket);
      return fail('Daily ad limit reached');
    }

    // ── كابتشا Cloudflare Turnstile كل N إعلان (افتراضيًا كل 3) ──────────
    // totalWatchedToday هو عدد الإعلانات المُحتسبة *قبل* هذا الإعلان، فلو
    // كان هذا الإعلان سيجعل الإجمالي مضاعفًا لـ interval، نطلب كابتشا صالحة
    // قبل صرف المكافأة. الواجهة الأمامية تُعيد نفس الطلب (بنفس adTicket)
    // مع turnstileToken بعد أن يحل المستخدم الكابتشا — فبنفك القفل هنا
    // (record.claiming = false) من غير ما نحذف التذكرة، عشان تفضل صالحة
    // للمحاولة اللي جاية بعد الكابتشا مباشرة.
    const turnstileInterval = Math.max(1, Math.floor(Number(config.turnstileAdsInterval ?? DEFAULT_CONFIG.turnstileAdsInterval ?? 3)));
    if ((totalWatchedToday + 1) % turnstileInterval === 0) {
      const secretKey = config.turnstileSecretKey || env.TURNSTILE_SECRET_KEY || DEFAULT_CONFIG.turnstileSecretKey;
      const verify = await verifyTurnstile(body.turnstileToken, ctx.ip, secretKey, {
        expectedHostname: config.turnstileExpectedHostname || undefined,
        expectedAction: 'ad_reward',
      });
      if (!verify.success) {
        record.claiming = false;
        return failCaptcha('You must pass the security check (Captcha) to continue and receive the ad reward');
      }
    }

    // التذكرة اتستخدمت فعليًا دلوقتي — تتحذف نهائيًا (single-use) قبل أي
    // صرف للمكافأة، فمينفعش حد يعيد استخدامها تاني مهما كانت النتيجة بعد كده.
    adNonceStore.delete(ticket);

    const reward = Math.floor(companyConfig.reward);
    if (!Number.isFinite(reward) || reward <= 0) return fail('Invalid ad reward');
    const newBalance = await incrementBalance(env, user.telegramId, reward);
    byCompany[company] = watched + 1;
    await dbUpdate(env, `users/${user.telegramId}`, {
      adWatchDate: today,
      adsWatchedByCompany: byCompany,
      adsWatchedToday: totalAdWatchCounters(byCompany),
      totalAdsWatched: Number(freshUser?.totalAdsWatched || 0) + 1,
    });
    await addBalanceLog(env, user.telegramId, { type: 'ad_reward', amount: reward, date: today, ts: Date.now() });
    if (watched + 1 >= 10) {
      await activateReferralIfNeeded(env, user.telegramId, config);
    }
    return ok({
      shibaBalance: newBalance,
      shibaAdded: reward,
      company,
      adsWatchedToday: totalAdWatchCounters(byCompany),
      adsWatchedByCompany: byCompany,
      adCompanies: getAllAdCompaniesConfig(config),
      adCompanyDailyLimit: limit,
      adDailyTotalLimit: Number(config.adDailyLimit ?? DEFAULT_CONFIG.adDailyLimit),
    });
  } catch (err) {
    // أي خطأ غير متوقع: نفك القفل بدل ما تفضل التذكرة "معلّقة" للأبد
    // (لو لسه موجودة أصلًا — ممكن تكون اتحذفت فوق لو الخطأ حصل بعدها).
    record.claiming = false;
    throw err;
  }
}

// ───────────────────────── Mining session ─────────────────────────
// مشاهدة إعلان تفتح جلسة تعدين واحدة. الرصيد لا يُحتسب من
// الواجهة: السيرفر يحسبه من وقت البداية، ولا يسمح بالمطالبة قبل ساعة.
async function handleStartMining(env, ctx) {
  const { user, config } = ctx;
  const path = `users/${user.telegramId}`;
  const freshUser = await dbGet(env, path);
  if (freshUser?.miningStartedAt) return fail('Mining is already in progress');
  const startedAt = Date.now();
  const miningReward = Number(config.miningReward ?? DEFAULT_CONFIG.miningReward);
  const miningDurationMs = Number(config.miningDurationMs ?? DEFAULT_CONFIG.miningDurationMs);
  await dbUpdate(env, path, { miningStartedAt: startedAt });
  return ok({
    startedAt,
    miningStartedAt: startedAt,
    miningReward,
    miningDurationMs,
  });
}

async function handleClaimMining(env, ctx) {
  const { user, config } = ctx;
  const path = `users/${user.telegramId}`;
  const freshUser = await dbGet(env, path);
  const startedAt = Number(freshUser?.miningStartedAt || 0);
  if (!startedAt) return fail('Watch the ad to start mining');
  const durationMs = Number(config.miningDurationMs ?? DEFAULT_CONFIG.miningDurationMs);
  if (Date.now() - startedAt < durationMs) return fail('Mining is not complete yet');
  const miningReward = Number(config.miningReward ?? DEFAULT_CONFIG.miningReward);
  const newBalance = await incrementBalance(env, user.telegramId, miningReward);
  await dbUpdate(env, path, { miningStartedAt: null, miningLastClaimedAt: Date.now() });
  await addBalanceLog(env, user.telegramId, { type: 'mining_reward', amount: miningReward, ts: Date.now() });
  return ok({ shibaBalance: newBalance, shibaAdded: miningReward, miningStartedAt: null });
}

// ───────────────────────── POST /playGame ─────────────────────────────
// لكل لعبة 3 محاولات يوميًا، مع فرض حدود المكافآت من السيرفر.
async function handlePlayGame(env, ctx) {
  const { user, body, config } = ctx;
  const telegramId = user.telegramId;
  const game = String(body.game || '');
  const maxRewards = { gem: 30, wheel: 36, xo: 10, fruit: 20 };
  const allowed = Object.keys(maxRewards);
  if (!allowed.includes(game)) return fail('Invalid game');

  const dailyLimit = Number(config.gameDailyLimit ?? DEFAULT_CONFIG.gameDailyLimit);
  const dateKey = todayKeyCairo();
  const path = `gamePlays/${telegramId}/${dateKey}/${game}`;
  const used = Number(await dbGet(env, path) || 0);
  if (used >= dailyLimit) return fail(`You've used all your available attempts (${dailyLimit}) for this game today`);

  // ── كابتشا Cloudflare Turnstile قبل صرف مكافأة أي لعبة (كل مرة) ─────
  // نتحقق قبل استهلاك محاولة اللعب حتى لا يخسر المستخدم محاولته لو فشل
  // في اجتياز الكابتشا. الواجهة تُعيد نفس الطلب مع turnstileToken بعد الحل.
  const secretKey = config.turnstileSecretKey || env.TURNSTILE_SECRET_KEY || DEFAULT_CONFIG.turnstileSecretKey;
  const verify = await verifyTurnstile(body.turnstileToken, ctx.ip, secretKey, {
    expectedHostname: config.turnstileExpectedHostname || undefined,
    expectedAction: 'game_reward',
  });
  if (!verify.success) {
    return failCaptcha('You must pass the security check (Captcha) to continue and receive the game reward');
  }

  const submittedScore = Math.floor(Number(body.score || 0));
  const score = Math.max(0, Math.min(maxRewards[game], Number.isFinite(submittedScore) ? submittedScore : 0));
  const reward = score;
  await dbSet(env, path, used + 1);

  let newBalance = user.balance || 0;
  if (reward > 0) newBalance = await incrementBalance(env, telegramId, reward);
  await addBalanceLog(env, telegramId, { type: 'game_reward', game, amount: reward, ts: Date.now() });
  const gamePlays = (await dbGet(env, `gamePlays/${telegramId}/${dateKey}`)) || {};
  return ok({ game, shibaBalance: newBalance, shibaAdded: reward, gamePlays });
}

// ───────────────────────── POST /checkForceSub ─────────────────────────
// تحقق فعلي (Live) عبر Telegram API من انضمام المستخدم لقنوات الاشتراك
// الإجباري. لو نجح لأول مرة، يتم تفعيل مكافأة الإحالة لو كان مُحالاً.
async function handleCheckForceSub(env, ctx) {
  const { user, config, botToken } = ctx;
  const status = await checkUserForceSub(env, user.telegramId, botToken, config);

  if (status.passed && !user.forceSubPassed) {
    await dbUpdate(env, `users/${user.telegramId}`, { forceSubPassed: true });
    await activateReferralIfNeeded(env, user.telegramId, config);
  }

  return ok(status);
}

// ───────────────────────── POST /startTask ─────────────────────────
// يُستدعى من الواجهة لحظة ضغط المستخدم على "Join" وفتح رابط المهمة.
// بيسجّل وقت البدء في السيرفر (وليس في المتصفح) عشان نقدر نفرض فترة
// الانتظار الحقيقية (15 ثانية - BOT_TASK_WAIT_SECONDS) على مهام "الانضمام
// لبوت" بدون إمكانية التحايل عليها من الواجهة الأمامية ─────
async function handleStartTask(env, ctx) {
  const { user, body } = ctx;
  const telegramId = user.telegramId;
  const taskId = body.taskId;

  if (!isNonEmptyString(taskId, 100)) {
    return fail('Invalid taskId');
  }

  const task = await dbGet(env, `tasks/${taskId}`);
  if (!task || task.status !== 'active' || task.category === 'invite') {
    return fail('Task not found or inactive');
  }

  const alreadyDone = await dbGet(env, `completedTasks/${telegramId}/${taskId}`);
  if (alreadyDone) {
    return fail("Reward already claimed");
  }

  // taskStarts/{telegramId}: مكان واحد بس لكل مستخدم بيحفظ آخر مهمة بدأها
  // (مش سجل منفصل لكل taskId يتراكم مع الوقت). لو بدأ مهمة جديدة، القيمة
  // القديمة بتتكتب فوقها تلقائيًا، ولو رجع لنفس المهمة اللي كان بدأها،
  // ميتغيرش وقت البدء (عشان محدش يقدر يصفّر العداد بالضغط على "Join" تاني).
  const existing = await dbGet(env, `taskStarts/${telegramId}`);
  if (!existing || existing.taskId !== taskId) {
    await dbSet(env, `taskStarts/${telegramId}`, { taskId, startedAt: Date.now() });
  }

  return ok({ taskId, waitSeconds: task.category === 'bots' ? BOT_TASK_WAIT_SECONDS : 0 });
}

// ───────────────────────── POST /verifyTask ─────────────────────────
async function handleVerifyTask(env, ctx) {
  const { user, body, config, botToken } = ctx;
  const telegramId = user.telegramId;
  const taskId = body.taskId;

  if (!isNonEmptyString(taskId, 100)) {
    return fail('Invalid taskId');
  }

  const task = await dbGet(env, `tasks/${taskId}`);
  if (!task || task.status !== 'active') {
    return fail('Task not found or inactive');
  }

  if (task.category === 'invite') {
    return fail('Use /claimTask for this task');
  }

  const alreadyDone = await dbGet(env, `completedTasks/${telegramId}/${taskId}`);
  if (alreadyDone) {
    return fail("Reward already claimed");
  }

  // نفس المكان الواحد اللي اتحفظ فيه taskStarts/{telegramId} في
  // /startTask — بنقراه مرة واحدة هنا ونستخدمه، وبعدين نمسحه لو خلصنا
  // المهمة دي بالتحديد (تحت).
  const startRecord = await dbGet(env, `taskStarts/${telegramId}`);

  if (task.category === 'bots') {
     // Bot tasks cannot be verified through Telegram Bot API. The server
     // records the link-open time and enforces a real BOT_TASK_WAIT_SECONDS
     // (15s) wait that can't be bypassed from the frontend. The message
     // shown to the user is simplified on purpose ("wait 5 seconds inside
     // the bot") as part of the fake/simplified verification UX — the
     // real enforced delay stays 15 seconds regardless of what the user
     // is told.
    const startedAt = (startRecord && startRecord.taskId === taskId) ? startRecord.startedAt : null;
    if (!startedAt) {
       return fail('Open the bot, wait 5s, then tap Verify');
    }
    const elapsedMs = Date.now() - startedAt;
    const requiredMs = BOT_TASK_WAIT_SECONDS * 1000;
    if (elapsedMs < requiredMs) {
       return fail('Open the bot, wait 5s, then tap Verify');
    }
  } else {
     // Channel tasks use a real live membership check through Telegram Bot API.
    const isMember = await checkTelegramMembership(env, task.link, telegramId, botToken);
    if (!isMember) {
       return fail('Join the channel first, then try again');
    }
  }

  const reward = task.reward ?? config.taskDefaultReward ?? DEFAULT_CONFIG.taskDefaultReward;
  const newBalance = await incrementBalance(env, telegramId, reward);

  await dbSet(env, `completedTasks/${telegramId}/${taskId}`, { completedAt: Date.now(), reward });
  await dbUpdate(env, `users/${telegramId}/completedTasks`, { [taskId]: true });
  // امسح مكان الـ taskStarts بتاع اليوزر ده — بس لو لسه بيشاور على نفس
  // المهمة اللي خلصناها (لو كان بدأ مهمة تانية بعد كده، سيبها زي ما هي).
  if (startRecord && startRecord.taskId === taskId) {
    await dbDelete(env, `taskStarts/${telegramId}`).catch(() => {});
  }
  await addBalanceLog(env, telegramId, {
    type: 'task_reward',
    taskId,
    amount: reward,
    ts: Date.now(),
  });

  // ── عدّاد إكمالات المهمة + الحذف التلقائي عند الوصول للهدف ───────
  // مهام ترويج القناة (channels/bots) بتُنشأ بعدد أعضاء مستهدف
  // (membersNeeded). كل مرة مستخدم يكمّل المهمة نزوّد العداد، ولو
  // العداد وصل للهدف تتحذف المهمة تلقائيًا من قائمة المهام النشطة.
  try {
    const newCompletions = (Number(task.completions) || 0) + 1;
    const target = Number(task.membersNeeded) || 0;
    if (target > 0 && newCompletions >= target) {
      await dbDelete(env, `tasks/${taskId}`);
    } else {
      await dbUpdate(env, `tasks/${taskId}`, { completions: newCompletions });
    }
  } catch (_) {}

  return ok({ shibaBalance: newBalance, shibaAdded: reward, taskId });
}

// ───────────────────────── POST /claimTask ─────────────────────────
// استلام مكافآت مهام الدعوة (Invite Friends) — يتم العدّ بالإحالات
// "النشطة" فقط (status === 'active'، أي عدّت الاشتراك الإجباري بنجاح)
async function handleClaimTask(env, ctx) {
  const { user, body, config } = ctx;
  const telegramId = user.telegramId;
  const taskId = body.taskId;

  if (!isNonEmptyString(taskId, 100)) {
    return fail('Invalid taskId');
  }

  const task = await dbGet(env, `tasks/${taskId}`);
  if (!task || task.status !== 'active' || task.category !== 'invite') {
    return fail('Invalid invite task');
  }

  const alreadyDone = await dbGet(env, `completedTasks/${telegramId}/${taskId}`);
  if (alreadyDone) {
    return fail("Reward already claimed");
  }

  const referralsRaw = await dbGet(env, `referrals/${telegramId}`);
  const referralsList = referralsRaw ? Object.values(referralsRaw) : [];
  // إحالة "نشطة" = وصلت لحالة completed (صرفت مكافأتها) — أو active من
  // نظام الأيام القديم (سجلات قديمة لم تُهاجَر بعد).
  const referralsCount = referralsList.filter((r) => r.status === 'active' || r.status === 'completed').length;
  const required = task.requiredReferrals || task.requiredCount || 0;

  if (referralsCount < required) {
    return fail(`You need at least ${required} active referrals (you have ${referralsCount})`);
  }

  const reward = task.reward ?? config.taskDefaultReward ?? DEFAULT_CONFIG.taskDefaultReward;
  const newBalance = await incrementBalance(env, telegramId, reward);

  await dbSet(env, `completedTasks/${telegramId}/${taskId}`, { completedAt: Date.now(), reward });
  await dbUpdate(env, `users/${telegramId}/completedTasks`, { [taskId]: true });
  await addBalanceLog(env, telegramId, {
    type: 'claim_task',
    taskId,
    amount: reward,
    ts: Date.now(),
  });

  return ok({ shibaBalance: newBalance, shibaAdded: reward, taskId });
}

// ───────────────────── POST /submitTaskSuggestion ─────────────────────
// طلب ترويج قناة (Promote Your Channel): صاحب القناة يحدد رابط القناة وعدد
// الأعضاء الجدد المطلوبين، ويتم حساب السعر تلقائيًا (200,000 شيبا / 100 عضو
// ≈ 1 دولار). الطلب يُحفظ بحالة "pending" ليتواصل الفريق مع صاحب القناة
// بتفاصيل الدفع قبل تفعيل المهمة على صفحة Tasks لكل المستخدمين.
async function handleSubmitTaskSuggestion(env, ctx) {
  const { user, body, config } = ctx;
  const name = String(body.name || '').trim();
  const link = body.link;
  const category = body.category === 'bots' ? 'bots' : 'channels';
  const membersNeeded = Math.floor(parseFloat(body.membersNeeded));
  const desc = body.desc || '';

  if (!isNonEmptyString(name, 120)) {
    return fail('Invalid task name');
  }
  if (!isNonEmptyString(link, 300) || !isValidUrl(link)) {
    return fail('Invalid channel link');
  }
  if (!Number.isFinite(membersNeeded) || membersNeeded < 100) {
    return fail('Minimum 100 members required');
  }
  if (typeof desc !== 'string' || desc.length > 1000) {
    return fail('Notes are too long');
  }

  const units = Math.ceil(membersNeeded / 100);
  const pricePer100Ton = Number(config.pricePer100MembersTon ?? DEFAULT_CONFIG.pricePer100MembersTon);
  const pricePer100Shiba = Number(config.pricePer100MembersShiba ?? DEFAULT_CONFIG.pricePer100MembersShiba);
  const pricePer100Usd = Number(config.pricePer100MembersUsd ?? DEFAULT_CONFIG.pricePer100MembersUsd);
  const priceShiba = units * pricePer100Shiba;
  const priceUsd = units * pricePer100Usd;
  const priceTon = Number((units * pricePer100Ton).toFixed(4));
  if (category === 'channels') {
    const botCheck = await checkBotAdminInChat(link, config.botToken);
    if (!botCheck.ok) return fail(botCheck.error);
  }
  const payment = await chargeTonBalance(env, user.telegramId, priceTon);
  if (!payment.ok) return fail(payment.error);

  // The bot task is accepted immediately. A channel task is accepted
  // immediately only after the bot-admin check above succeeds.
  {
    const taskId = `user_${category}_${user.telegramId}_${Date.now()}`;
    await dbSet(env, `tasks/${taskId}`, {
      id: taskId,
      title: name,
      link,
      category,
      ownerTelegramId: user.telegramId,
      reward: Number(config.taskDefaultReward ?? DEFAULT_CONFIG.taskDefaultReward),
       status: 'active',
      paymentCurrency: 'TON',
      paymentAmountTon: priceTon,
      membersNeeded,
       createdAt: Date.now(),
    });
    return ok({
      taskId,
      priceTon,
      tonBalance: payment.tonBalance,
      acceptedInstantly: true,
      botAdminVerified: category === 'channels',
    });
  }
}

// ───────────────────────── POST /spinWheel ─────────────────────────
// تنفيذ لفة عجلة الحظ: يتم حساب عدد اللفات المتاحة من الإحالات النشطة
// الحقيقية في قاعدة البيانات (مش من بيانات initData القديمة) لمنع التلاعب،
// ثم اختيار قطاع عشوائي بحسب الأوزان وإضافة المكافأة (لو > 0) للرصيد.
async function handleSpinWheel(env, ctx) {
  const { user } = ctx;
  const telegramId = user.telegramId;

  const referralsRaw = await dbGet(env, `referrals/${telegramId}`);
  const referralsList = referralsRaw ? Object.values(referralsRaw) : [];
  const activeReferralsCount = referralsList.filter((r) => r.status === 'active' || r.status === 'completed').length;

  const freshUser = await dbGet(env, `users/${telegramId}`);
  const spinsUsed = freshUser?.wheelSpinsUsed || 0;
  const spinsAvailable = computeSpinsAvailable(activeReferralsCount, spinsUsed);

  if (spinsAvailable <= 0) {
    return fail(`No spins available. You need to invite ${WHEEL_REFERRALS_PER_SPIN} active friends for each new spin`);
  }

  const segmentIndex = pickWheelSegmentIndex();
  const reward = WHEEL_SEGMENTS[segmentIndex].reward;
  const newSpinsUsed = spinsUsed + 1;

  let newBalance = freshUser?.balance || 0;
  if (reward > 0) {
    newBalance = await incrementBalance(env, telegramId, reward);
  }
  await dbUpdate(env, `users/${telegramId}`, { wheelSpinsUsed: newSpinsUsed });

  if (reward > 0) {
    await addBalanceLog(env, telegramId, {
      type: 'wheel_spin',
      amount: reward,
      ts: Date.now(),
    });
  }

  return ok({
    segmentIndex,
    reward,
    shibaBalance: newBalance,
    spinsAvailable: computeSpinsAvailable(activeReferralsCount, newSpinsUsed),
    spinsUsed: newSpinsUsed,
  });
}

// ───────────────────────── POST /checkCombo ─────────────────────────
async function handleCheckCombo(env, ctx) {
  const { user, body, config } = ctx;
  const telegramId = user.telegramId;
  const selection = body.selection;

  if (!Array.isArray(selection) || selection.length !== 4) {
    return fail('You must select exactly 4 items');
  }
  if (!selection.every((s) => typeof s === 'string' && s.length <= 8)) {
    return fail('Invalid selection items');
  }

  const dateKey = todayKeyUTC();

  if (user.comboClaimDate === dateKey) {
    return fail("Combo reward already claimed today");
  }

  const combo = await getOrCreateTodayCombo(env, config);
  const isCorrect = JSON.stringify(selection) === JSON.stringify(combo.items);

  if (!isCorrect) {
    return ok({ correct: false });
  }

  const reward = combo.reward ?? config.comboReward ?? DEFAULT_CONFIG.comboReward;
  const newBalance = await incrementBalance(env, telegramId, reward);

  await dbUpdate(env, `users/${telegramId}`, { comboClaimDate: dateKey });

  await addBalanceLog(env, telegramId, {
    type: 'combo_claim',
    amount: reward,
    date: dateKey,
    ts: Date.now(),
  });

  return ok({ correct: true, shibaBalance: newBalance, shibaAdded: reward });
}

// ════════════════════════════════════════════════════════════════════
//  تصنيف الإحالات الأسبوعي (Weekly Referral Leaderboard/Contest)
// ════════════════════════════════════════════════════════════════════
//  البنية داخل Firebase:
//   weeklyContest/state          -> { periodId, startTs, endTs }  (الأسبوع الحالي)
//   weeklyContest/history/{id}   -> نتائج/جوائز أسبوع منتهى، وبتُستخدم
//                                   كـ "قفل" لمنع صرف نفس الأسبوع مرتين.
//
//  فكرة الحساب: كل إحالة (دعوة) مسجّلة أصلًا تحت referrals/{referrerId}/
//  {referredId} ومعاها joinedAt (وقت انضمام المدعو). عشان "الاحالات
//  تتحسب من فترة بدء المسابقة فقط"، بنعدّ بس الإحالات اللي joinedAt
//  بتاعها وقعت بعد startTs الحالي — أي إحالات قديمة قبل بداية الأسبوع
//  الحالي (حتى لو نفس المستخدم) متتحسبش ضمن نقاط الأسبوع ده.
// ════════════════════════════════════════════════════════════════════

function weeklyContestPrizes(config) {
  const arr = Array.isArray(config?.weeklyContestPrizesTon) && config.weeklyContestPrizesTon.length === 10
    ? config.weeklyContestPrizesTon
    : DEFAULT_CONFIG.weeklyContestPrizesTon;
  return arr.map((n) => Number(n) || 0);
}

function weeklyContestDuration(config) {
  const n = Number(config?.weeklyContestDurationMs);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONFIG.weeklyContestDurationMs;
}

function makeWeeklyPeriodId(startTs) {
  return `wc_${startTs}`;
}

// يتأكد إن فيه فترة مسابقة حالية محفوظة في Firebase، ولو مفيش (أول
// تشغيل للنظام) بينشئ فترة جديدة تبدأ فورًا. لا يتحقق من انتهاء الفترة
// (ده مسؤولية ensureWeeklyContestUpToDate).
async function getOrInitWeeklyContestState(env, config) {
  let state = await dbGet(env, 'weeklyContest/state');
  if (!state || !state.startTs || !state.endTs) {
    const startTs = Date.now();
    state = { periodId: makeWeeklyPeriodId(startTs), startTs, endTs: startTs + weeklyContestDuration(config) };
    await dbSet(env, 'weeklyContest/state', state);
  }
  return state;
}

// يحسب تصنيف الإحالات لفترة [startTs, endTs) اعتمادًا على joinedAt
// المخزّنة تحت referrals/{referrerId}/{referredId}. بيرجع كل المستخدمين
// اللي دعوا مستخدم واحد على الأقل خلال الفترة، مرتبين تنازليًا حسب
// العدد. عند تساوي العدد بين مستخدمين، يتم تفضيل من بدأ الدعوة أبكر
// (أقدم إحالة له ضمن الفترة) كتقريب عملي لـ"مين وصل للرقم ده الأول".
async function computeWeeklyReferralLeaderboard(env, startTs, endTs) {
  const [allReferrals, allUsers] = await Promise.all([
    dbGet(env, 'referrals'),
    dbGet(env, 'users'),
  ]);
  const rows = [];
  if (allReferrals) {
    for (const [referrerId, refs] of Object.entries(allReferrals)) {
      if (!refs || typeof refs !== 'object') continue;
      let count = 0;
      let earliestTs = Infinity;
      for (const r of Object.values(refs)) {
        const status = r?.status || 'active';
        const isActive = status === 'active' || status === 'completed';
        const joinedAt = Number(r?.joinedAt || 0);
        // بنحسب فقط الإحالات "النشطة" (active/completed) اللي انضمت خلال
        // الفترة الحالية — أي إحالة غير نشطة (لسه ما فعّلتش الاشتراك
        // الإجباري أو محسوبة احتيال) لا تُحتسب في التصنيف إطلاقًا.
        if (isActive && joinedAt >= startTs && joinedAt < endTs) {
          count += 1;
          if (joinedAt < earliestTs) earliestTs = joinedAt;
        }
      }
      if (count > 0) {
        const u = (allUsers && allUsers[referrerId]) || {};
        rows.push({
          telegramId: referrerId,
          firstName: u.firstName || '',
          username: u.username || '',
          photoUrl: u.photoUrl || '',
          count,
          earliestTs,
        });
      }
    }
  }
  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.earliestTs !== b.earliestTs) return a.earliestTs - b.earliestTs;
    return String(a.telegramId).localeCompare(String(b.telegramId));
  });
  return rows;
}

// يوزّع جوائز أسبوع منتهى (لو مش اتوزعت قبل كده) ثم يبدأ فترة جديدة
// فورًا بعده (استمرارية بدون فجوة زمنية بين الأسابيع). بيستخدم
// weeklyContest/history/{periodId} كقفل: أول حاجة بتتعمل هي تسجيل
// "distributing: true" قبل حساب/صرف أي جايزة، فلو النظام اتنادى تاني
// لنفس الفترة (سواء من طلب مستخدم أو من الفحص الدوري) هيلاقي القفل
// ويتجاهلها بدل ما يصرف الجايزة مرتين.
async function finalizeAndAdvanceWeeklyPeriod(env, config, state) {
  const periodId = state.periodId || makeWeeklyPeriodId(state.startTs);
  const historyPath = `weeklyContest/history/${periodId}`;

  const existingHistory = await dbGet(env, historyPath);
  if (!existingHistory || (!existingHistory.distributed && !existingHistory.distributing)) {
    // قفل مبدئي فورًا قبل أي حساب أو صرف — أهم سطر في منع الصرف المزدوج.
    await dbSet(env, historyPath, {
      startTs: state.startTs,
      endTs: state.endTs,
      distributed: false,
      distributing: true,
      lockedAt: Date.now(),
    });

    const leaderboard = await computeWeeklyReferralLeaderboard(env, state.startTs, state.endTs);
    const prizes = weeklyContestPrizes(config);
    const winners = [];

    for (let i = 0; i < prizes.length; i++) {
      const row = leaderboard[i];
      const prizeTon = prizes[i];
      if (!row || !(prizeTon > 0)) continue;
      try {
        const freshUser = await dbGet(env, `users/${row.telegramId}`);
        const currentTonBalance = Number(freshUser?.tonBalance || 0);
        const newTonBalance = Number((currentTonBalance + prizeTon).toFixed(6));
        await dbUpdate(env, `users/${row.telegramId}`, { tonBalance: newTonBalance });
        await addBalanceLog(env, row.telegramId, {
          type: 'weekly_referral_contest_prize',
          amount: prizeTon,
          currency: 'TON',
          rank: i + 1,
          referralsCount: row.count,
          periodId,
          ts: Date.now(),
        });
        await sendTelegramMessage(env, config.botToken || '', row.telegramId,
          `🏆 Weekly Referral Contest results!\n\nYou finished #${i + 1} this week with ${row.count} referral${row.count === 1 ? '' : 's'}.\n\n💎 +${prizeTon} TON has been credited to your balance automatically.\n\n🔄 A brand new weekly contest just started — invite friends to compete again!`);
        winners.push({ rank: i + 1, telegramId: row.telegramId, firstName: row.firstName, username: row.username, photoUrl: row.photoUrl, count: row.count, prizeTon });
      } catch (err) {
        // فشل صرف جايزة مستخدم واحد ميوقفش صرف باقي المستخدمين — بنسجل
        // الخطأ في السجل التاريخي عشان تقدر تراجعه يدويًا من Firebase.
        winners.push({ rank: i + 1, telegramId: row.telegramId, count: row.count, prizeTon, error: String(err && err.message || err) });
      }
    }

    await dbSet(env, historyPath, {
      startTs: state.startTs,
      endTs: state.endTs,
      distributed: true,
      distributing: false,
      distributedAt: Date.now(),
      totalPrizeTon: winners.reduce((s, w) => s + (w.error ? 0 : w.prizeTon), 0),
      winners,
    });
  }
  // لو كانت الفترة أصلًا "distributing: true" من محاولة سابقة اتقطعت
  // فجأة (مثلاً السيرفر اتقفل أثناء الصرف)، بنسيبها كده من غير إعادة
  // محاولة تلقائية — الأمان من صرف مزدوج أهم من استمرارية 100% تلقائية،
  // وتقدر تراجعها يدويًا من Firebase تحت نفس المسار.

  const nextStartTs = state.endTs;
  const nextState = {
    periodId: makeWeeklyPeriodId(nextStartTs),
    startTs: nextStartTs,
    endTs: nextStartTs + weeklyContestDuration(config),
  };
  await dbSet(env, 'weeklyContest/state', nextState);
  return nextState;
}

// نقطة الدخول الرئيسية لتحديث حالة المسابقة: بترجع الفترة الحالية بعد
// ما تتأكد إنها فعلاً "حالية" (لو خلصت فترة أو أكتر وإحنا مكناش عارفين،
// زي لو السيرفر كان مقفول لفترة، بيلف على كل فترة خلصت ويوزع جوائزها
// بالترتيب قبل ما يرجّع الفترة النشطة الحالية).
async function ensureWeeklyContestUpToDate(env, config) {
  let state = await getOrInitWeeklyContestState(env, config);
  let guard = 0; // حماية بسيطة من أي حلقة لا نهائية غير متوقعة
  while (Date.now() >= state.endTs && guard < 60) {
    state = await finalizeAndAdvanceWeeklyPeriod(env, config, state);
    guard++;
  }
  return state;
}

// ───────────────────────── POST /getWeeklyLeaderboard ─────────────────────────
// تصنيف الإحالات الأسبوعي: أعلى 10 مستخدمين حسب عدد الإحالات المسجّلة
// من "بداية الأسبوع الحالي" فقط (وليس إجمالي إحالاتهم من الأول)، + وقت
// انتهاء الأسبوع الحالي (للتايمر في الواجهة) + ترتيب المستخدم الحالي.
async function handleGetWeeklyLeaderboard(env, ctx) {
  const { user, config } = ctx;
  const state = await ensureWeeklyContestUpToDate(env, config);
  const leaderboard = await computeWeeklyReferralLeaderboard(env, state.startTs, state.endTs);
  const prizes = weeklyContestPrizes(config);

  const TOP_LIMIT = 25;
  const top = leaderboard.slice(0, TOP_LIMIT).map((row, i) => ({
    rank: i + 1,
    telegramId: row.telegramId,
    firstName: row.firstName,
    username: row.username,
    photoUrl: row.photoUrl,
    referralsThisWeek: row.count,
    activeReferrals: row.count,
    prizeTon: prizes[i] || 0,
  }));

  const myIndex = leaderboard.findIndex((r) => String(r.telegramId) === String(user.telegramId));

  return ok({
    weekStartTs: state.startTs,
    weekEndTs: state.endTs,
    prizesTon: prizes,
    totalPrizePoolTon: Number(prizes.reduce((s, n) => s + n, 0).toFixed(4)),
    leaderboard: top,
    topLimit: TOP_LIMIT,
    myRank: myIndex >= 0 ? myIndex + 1 : null,
    myReferralsThisWeek: myIndex >= 0 ? leaderboard[myIndex].count : 0,
    myActiveReferrals: myIndex >= 0 ? leaderboard[myIndex].count : 0,
    note: 'Ranking is based only on ACTIVE referrals joined since the start of this round — inactive/unverified invites are never counted.',
  });
}

// ───────────────────────── POST /getReferrals ─────────────────────────
async function handleGetReferrals(env, ctx) {
  const { user } = ctx;
  const referralsRaw = await dbGet(env, `referrals/${user.telegramId}`);
  const referrals = referralsRaw
    ? Object.entries(referralsRaw).map(([id, r]) => ({ id, ...r, status: r.status || 'pending' }))
    : [];

  return ok({
    referrals,
    total: referrals.length,
    active: referrals.filter((r) => r.status === 'active' || r.status === 'completed').length,
    referralCode: user.referralCode,
  });
}

// ───────────────────────── POST /requestWithdrawal ─────────────────────────
// طلب سحب عملات SHIBA إلى عنوان محفظة BEP-20 (شبكة BNB Smart Chain) الخاص
// بالمستخدم.
// المعالجة (تحويل العملة فعليًا) تتم يدويًا من صاحب المشروع، ثم يقوم
// بتحديث status السحب في Firebase (withdrawals/{telegramId}/{id}) من
// "pending" إلى "completed" أو "rejected".
// تنبيه: في حال الرفض، الرصيد لا يُرجع تلقائيًا — يجب إرجاعه يدويًا عبر
// تعديل users/{telegramId}/balance في Firebase إذا تقرر رفض الطلب.
async function handleRequestWithdrawal(env, ctx) {
  const { user, body, config, botToken } = ctx;
  const telegramId = user.telegramId;

  if (config.withdrawalEnabled === false) {
    return fail('Withdrawals are currently disabled');
  }

  const walletAddress = String(body.walletAddress || '').trim();
  const amount = Number(parseFloat(body.amountTon));

  if (!/^([UE]Q)[A-Za-z0-9_-]{46}$/.test(walletAddress)) {
    return fail('Invalid wallet address (must start with UQ/EQ)');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail('Invalid amount');
  }

  // قراءة رصيد لحظي (مش الرصيد المخزّن في initData القديم) لمنع التلاعب
  const freshUser = await dbGet(env, `users/${telegramId}`);
  const balance = Number(freshUser?.tonBalance || 0);
  const today = todayKeyCairo();
  const adsByCompanyToday = freshUser?.adWatchDate === today
    ? normalizeAdWatchCounters(freshUser.adsWatchedByCompany, freshUser.adsWatchedToday)
    : {};
  // شرط السحب بيعتمد فقط على عدد إعلانات Adsgram (الشركات التانية زي
  // gigapub و monetix بتفضل تدي مكافأة عادية للمستخدم، لكن مبتتحسبش في
  // شرط عدد الإعلانات المطلوب قبل السحب)
  const watchedAds = Number(adsByCompanyToday.adsgram || 0);
  const previousWithdrawals = await dbGet(env, `withdrawals/${telegramId}`);
  const withdrawalCount = previousWithdrawals ? Object.keys(previousWithdrawals).length : 0;
  const withdrawalRules = [
    { min: 0.1, ads: 15 },
    { min: 0.2, ads: 20 },
    { min: 0.3, ads: 25 },
  ];
  const rule = withdrawalRules[Math.min(withdrawalCount, 2)];
  if (watchedAds < rule.ads) {
    return fail(`You must watch ${rule.ads} ads before withdrawal ${withdrawalCount + 1}.`);
  }
  if (amount < rule.min) {
    return fail(`Minimum withdrawal ${withdrawalCount + 1} is ${rule.min} TON.`);
  }
  if (amount > balance) {
    return fail('Insufficient TON balance.');
  }

  const feeRate = 0.10;
  const fee = Number((amount * feeRate).toFixed(4));
  const netAmount = Number((amount - fee).toFixed(4));
  const newBalance = balance - amount;
  // تصفير عداد الإعلانات المستخدم في شرط السحب: العداد أصلاً بيتصفر يوميًا
  // (لأنه مربوط بـ adWatchDate)، وبعد التعديل ده بيتصفر كمان فورًا بعد أي
  // عملية سحب ناجحة، عشان المستخدم يحتاج يشاهد إعلانات جديدة قبل السحب التالي
  // حتى لو لسه في نفس اليوم.
  await dbUpdate(env, `users/${telegramId}`, {
    tonBalance: newBalance,
    tonWallet: walletAddress,
    adWatchDate: today,
    adsWatchedByCompany: {},
    adsWatchedToday: 0,
  });

  const withdrawalId = await dbPush(env, `withdrawals/${telegramId}`, {
    walletAddress,
    amount: netAmount,
    requestedAmount: amount,
    fee,
    feeRate,
    netAmount,
    currency: 'TON',
    withdrawalNumber: withdrawalCount + 1,
    adsRequired: rule.ads,
    status: 'pending',
    ts: Date.now(),
    // نخزّن لقطة من بيانات المستخدم وقت طلب السحب (اسم/يوزر/صورة) عشان
    // تُستخدم لاحقًا في صفحة "Record" العامة اللي بتعرض كل السحوبات
    // المكتملة، من غير ما نحتاج نقرأ users/ لكل مستخدم في كل مرة.
    firstName: user.firstName || '',
    username: user.username || '',
    photoUrl: user.photoUrl || '',
  });

  await addBalanceLog(env, telegramId, {
    type: 'withdrawal',
    amount: -amount,
    currency: 'TON',
    status: 'pending',
    withdrawalId,
    ts: Date.now(),
  });

  // ── إشعار المستخدم عبر البوت بإنشاء طلب السحب ───────────────────────
  // رسالة إعلامية فقط (لا تؤثر على نتيجة الطلب حتى لو فشل الإرسال —
  // sendTelegramMessage نفسها بتبتلع أي خطأ شبكة/توكن من غير ما توقف
  // باقي الكود، فالسحب بيتسجل بنجاح في كل الأحوال).
  const displayName = user.username
    ? `@${user.username}`
    : (user.firstName || String(telegramId));
  const withdrawalNotifyMessage =
    `💸 Withdrawal Request Submitted Successfully! ✅\n\n` +
    `👤 Name: ${displayName}\n` +
    `🆔 Account ID: "${telegramId}"\n` +
    `💳 Wallet Address:\n"${walletAddress}"\n\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `💰 Amount: "${amount}" TON\n` +
    `📌 Status: 🟡 Processing\n\n` +
    `⏳ Estimated Arrival:\n` +
    `Your withdrawal will be processed and sent to your wallet within 24–72 hours.\n\n` +
    `💜 Thank you for using PMT Gram\n` +
    `━━━━━━━━━━━━━━━`;
  await sendTelegramMessage(env, botToken || config.botToken || '', telegramId, withdrawalNotifyMessage);

  return ok({
    tonBalance: newBalance,
    withdrawalId,
    requestedAmount: amount,
    fee,
    netAmount,
    adsWatchedToday: 0,
    adsWatchedByCompany: {},
  });
}

// ───────────────────────── POST /createDeposit ───────────────────────
// يسجل BOC المرسل من TonConnect كإيداع معلّق. لا يتم إضافة الرصيد
// قبل التحقق من المعاملة عبر TonCenter.
async function handleCreateDeposit(env, ctx) {
  const { user, body } = ctx;
  const amount = Number(body.amount);
  const txHash = String(body.txHash || '').trim();
  if (!Number.isFinite(amount) || amount <= 0 || !txHash) {
    return fail('Incomplete deposit data');
  }
  const depositId = await dbPush(env, `deposits/${user.telegramId}`, {
    userId: String(user.telegramId),
    amount,
    txHash,
    receiver: DEPOSIT_RECEIVER_WALLET,
    status: 'pending',
    ts: Date.now(),
  });
  return ok({ depositId });
}

// ───────────────────────── POST /verifyDeposit ───────────────────────
// نفس دورة التحقق الموجودة في نظام الإيداع العامل، مع تخزين Firebase
// وحساب رصيد PMT الحالي بدل KV المستخدم في التطبيق المنفصل.
async function handleVerifyDeposit(env, ctx) {
  const { user, body } = ctx;
  const depositId = String(body.depositId || '').trim();
  if (!depositId) return fail('Deposit ID missing');
  const path = `deposits/${user.telegramId}/${depositId}`;
  const deposit = await dbGet(env, path);
  if (!deposit) return fail('Deposit not found', 404);
  if (deposit.status === 'completed') {
    const fresh = await dbGet(env, `users/${user.telegramId}`);
    return ok({ status: 'completed', amount: deposit.amount, tonBalance: Number(fresh?.tonBalance || 0) });
  }
  if (!env.TONCENTER_API_KEY) return fail('TONCENTER_API_KEY missing', 500);

  const response = await fetch(
    `https://toncenter.com/api/v2/getTransactions?address=${DEPOSIT_RECEIVER_WALLET}&limit=20`,
    { headers: { 'X-API-Key': env.TONCENTER_API_KEY } },
  );
  if (!response.ok) return fail('Unable to verify transaction, try later', 502);
  const data = await response.json();
  const found = (data.result || []).some((tx) => {
    const inMsg = tx.in_msg;
    if (!inMsg) return false;
    const valueTon = Number(inMsg.value) / 1e9;
    return Math.abs(valueTon - Number(deposit.amount)) < 0.001 &&
      tx.transaction_id?.hash === deposit.txHash;
  });
  if (!found) return ok({ status: 'pending', tonBalance: Number(user.tonBalance || 0) });

  const freshUser = await dbGet(env, `users/${user.telegramId}`);
  const tonBalance = Number(freshUser?.tonBalance || 0) + Number(deposit.amount);
  await dbUpdate(env, `users/${user.telegramId}`, { tonBalance });
  await dbUpdate(env, path, { status: 'completed', completedAt: Date.now() });
  await addBalanceLog(env, user.telegramId, {
    type: 'deposit',
    amount: Number(deposit.amount),
    currency: 'TON',
    depositId,
    status: 'completed',
    ts: Date.now(),
  });
  return ok({ status: 'completed', amount: deposit.amount, tonBalance });
}

// Convert PMT to TON. No external payment or blockchain verification is used.
async function handleConvertPmtToTon(env, ctx) {
  const { user, body, config } = ctx;
  const pmtAmount = Math.floor(Number(body.pmtAmount));
  const rate = Number(config.tonConversionRate || DEFAULT_CONFIG.tonConversionRate || 10000);
  if (!Number.isFinite(pmtAmount) || pmtAmount <= 0) {
    return fail('Invalid amount');
  }
  const freshUser = await dbGet(env, `users/${user.telegramId}`);
  const pmtBalance = Number(freshUser?.balance || 0);
  if (pmtAmount > pmtBalance) return fail('Insufficient PMT balance.');
  const tonAdded = pmtAmount / rate;
  const tonBalance = Number(freshUser?.tonBalance || 0) + tonAdded;
  await dbUpdate(env, `users/${user.telegramId}`, {
    balance: pmtBalance - pmtAmount,
    tonBalance,
  });
  await addBalanceLog(env, user.telegramId, {
    type: 'pmt_to_ton',
    amount: -pmtAmount,
    currency: 'PMT',
    tonAdded,
    ts: Date.now(),
  });
  return ok({ shibaBalance: pmtBalance - pmtAmount, tonBalance, pmtAmount, tonAdded });
}

// ════════════════════════════════════════════════════════════════════
//  جدول التوجيه (Routing Table)
// ════════════════════════════════════════════════════════════════════
const ROUTES = {
  '/getState': handleGetState,
  '/heartbeat': handleHeartbeat,
  '/claimDailyBonus': handleClaimDailyBonus,
  '/redeemCode': handleRedeemCode,
  '/checkSession': handleStartAdView,
  '/syncBalance': handleClaimAdReward,
  '/sessionSync': handleSessionSync,
  '/startMining': handleStartMining,
  '/claimMining': handleClaimMining,
  '/playGame': handlePlayGame,
  '/startTask': handleStartTask,
  '/verifyTask': handleVerifyTask,
  '/claimTask': handleClaimTask,
  '/submitTaskSuggestion': handleSubmitTaskSuggestion,
  '/checkCombo': handleCheckCombo,
  '/spinWheel': handleSpinWheel,
  '/getReferrals': handleGetReferrals,
  '/getWeeklyLeaderboard': handleGetWeeklyLeaderboard,
  '/checkForceSub': handleCheckForceSub,
  '/requestWithdrawal': handleRequestWithdrawal,
  '/createDeposit': handleCreateDeposit,
  '/verifyDeposit': handleVerifyDeposit,
  '/convertPmtToTon': handleConvertPmtToTon,
};

// ════════════════════════════════════════════════════════════════════
//  نقطة الدخول الرئيسية (كانت export default { fetch } بتاعة الـ Worker،
//  دلوقتي بقت function عادية بتاخد Request/env وترجع Response — نفس
//  الشكل بالظبط، بس بتتنادى من سيرفر Node.js تحت بدل Cloudflare)
// ════════════════════════════════════════════════════════════════════
async function handleFetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!env.FIREBASE_DATABASE_URL) {
      return fail('Server misconfigured: missing FIREBASE_DATABASE_URL', 500);
    }

    // ملف TonConnect عام، مطلوب قبل فتح نافذة ربط المحفظة.
    if (request.method === 'GET' && new URL(request.url).pathname === '/tonconnect-manifest.json') {
      return json({
        // رابط الويب الذي سيظهر داخل بيانات TonConnect، وليس رابط الـ Worker.
        url: 'https://pmt gram.com',
        name: 'Pmt Gram',
        iconUrl: 'https://res.cloudinary.com/q1tmmkbe/image/upload/v1787498355/ChatGPT_Image_Aug_23_2026_06_20_10_PM.png',
      });
    }

    if (request.method !== 'POST') {
      return fail('Method Not Allowed', 405);
    }

    const url = new URL(request.url);
    let path = url.pathname;

    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      return fail('Invalid body, must be JSON');
    }

    if ((path === '/' || path === '') && body.action) {
      path = '/' + body.action;
      body = body.data || {};
    }

    const handler = ROUTES[path];
    if (!handler) {
      return fail('Endpoint not found: ' + path, 404);
    }

    let initData = '';
    const authHeader = request.headers.get('Authorization') || '';
    const customHeader = request.headers.get('X-Telegram-Init-Data') || '';
    if (authHeader.startsWith('tma ')) initData = authHeader.slice(4);
    else if (authHeader.startsWith('Telegram ')) initData = authHeader.slice(9);
    else if (customHeader) initData = customHeader;
    else if (body._initData) initData = body._initData;

    // Railway بيحط IP العميل الحقيقي في X-Forwarded-For (Cloudflare كان بيحطه
    // في CF-Connecting-IP، فبنسيب الاتنين كـ fallback للتوافق).
    const forwardedFor = request.headers.get('X-Forwarded-For') || '';
    const ip = request.headers.get('CF-Connecting-IP')
      || (forwardedFor ? forwardedFor.split(',')[0].trim() : '')
      || 'unknown';
    if (!checkRateLimit(ip)) {
      return fail('Too many requests, try later', 429);
    }

    // ───── تحميل الإعدادات من Firebase (تشمل botToken/botUsername الفعليين) ─────
    let config;
    try {
      config = await getConfig(env);
    } catch (err) {
      return fail('Failed to load settings: ' + err.message, 500);
    }

    const botToken = config.botToken || env.BOT_TOKEN || '';
    const botUsername = config.botUsername || env.BOT_USERNAME || 'Pmt_Gram_Bot';

    if (!botToken) {
      return fail('BOT_TOKEN is not set', 500);
    }

    const verification = await verifyTelegramInitData(initData, botToken);
    if (!verification.valid) {
      return fail('Unauthorized: ' + verification.error, 401);
    }

    try {
      // بعض إصدارات Telegram تعرض startapp داخل initDataUnsafe فقط في الواجهة.
      // نستخدمه كبديل بعد نجاح التحقق من initData، مع تقييد القيمة إلى صيغة
      // كود الإحالة التي ينشئها السيرفر.
      const rawStartParam = verification.startParam || body._startParam || '';
      const startParam = /^[A-Za-z0-9_-]{1,128}$/.test(String(rawStartParam))
        ? String(rawStartParam)
        : null;
      const user = await getOrCreateUser(env, verification.user, startParam, config, botToken, body);

      // ── حظر الحساب (نظام حماية تعدد الحسابات) ───────────────────────
      // قراءة واحدة بس (blocks/{telegramId}) على كل طلب. المسح الكامل
      // لجدول users بحثًا عن بصمة جهاز مكررة بقى بيحصل مرة واحدة بس عند
      // إنشاء حساب جديد كليًا (جوه getOrCreateUser فوق)، مش هنا على كل
      // طلب زي النظام القديم.
      const blockCheck = await checkUserBlocked(env, user.telegramId);
      if (blockCheck && blockCheck.isBlocked) {
        let linkedAccounts = [];
        try {
          linkedAccounts = await getSharedAccountsForDevice(env, blockCheck.deviceFingerprint, user.telegramId);
        } catch (_) {}
        return failBlocked(blockCheck.reason, blockCheck.violation, linkedAccounts);
      }
      // ─────────────────────────────────────────────────────────────

      const ctx = { user, body, tgUser: verification.user, config, botToken, botUsername, ip };
      return await handler(env, ctx);
    } catch (err) {
      return fail('A server error occurred: ' + err.message, 500);
    }
}

// ════════════════════════════════════════════════════════════════════
//  تشغيل سيرفر Node.js (Railway) — بديل export default fetch الخاص
//  بـ Cloudflare Workers. بيحوّل كل طلب HTTP جايّ لـ Web Request/Response
//  قياسي (متوفرين كـ globals في Node 18+) وبعدين يناديله handleFetch
//  فوق من غير أي تغيير في منطق الراوتس أو الهاندلرز.
// ════════════════════════════════════════════════════════════════════
import http from 'node:http';

const server = http.createServer(async (req, res) => {
  try {
    // بنجمع الـ body كامل كـ Buffer عشان نبنيه كـ Web Request (زي ما كان
    // بيوصل لـ Cloudflare Worker).
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = chunks.length ? Buffer.concat(chunks) : undefined;

    const host = req.headers.host || `localhost:${process.env.PORT || 3000}`;
    const url = `http://${host}${req.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    const hasBody = !['GET', 'HEAD'].includes(req.method) && bodyBuffer;
    const request = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? bodyBuffer : undefined,
    });

    // على Railway الإعدادات (Secrets/Variables) بتوصل عن طريق process.env
    // بدل الـ env binding بتاع Cloudflare — نفس الأسماء بالظبط
    // (FIREBASE_DATABASE_URL, BOT_TOKEN, BOT_USERNAME, TURNSTILE_SECRET_KEY,
    // TONCENTER_API_KEY... إلخ) لازم تتضاف من Railway > Variables.
    const env = process.env;

    const response = await handleFetch(request, env);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, error: 'A server error occurred: ' + err.message, serverTime: Date.now() }));
  }
});

// Railway بيحدد البورت تلقائيًا عن طريق متغير PORT — لازم نسمعه بالظبط
// وعلى 0.0.0.0 مش على localhost فقط.
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is running on port ${PORT}`);
});

// ════════════════════════════════════════════════════════════════════
//  المسابقة الأسبوعية للإحالات — فحص دوري تلقائي (بديل Cron Job)
//  بما إن السيرفر ده Node.js عادي شغال باستمرار على Railway (مش
//  Serverless زي Cloudflare Workers)، نقدر نستخدم setInterval عادي
//  يتأكد كل دقيقة هل الأسبوع الحالي خلص ولا لأ. لو خلص: يوزع الجوائز
//  تلقائيًا على أول 10 في التصنيف ويبدأ أسبوع جديد فورًا — من غير ما
//  يحتاج أي مستخدم يفتح البوت في اللحظة اللي بيخلص فيها الأسبوع.
//  (نفس الحماية من الصرف المزدوج بتاعة weeklyContest/history/{id}
//  موجودة برضه هنا، فحتى لو الفحص الدوري ده اتنادى في نفس اللحظة اللي
//  حد بيفتح فيها البوت، مش هيحصل صرف مرتين لنفس الأسبوع).
// ════════════════════════════════════════════════════════════════════
const WEEKLY_CONTEST_CHECK_INTERVAL_MS = 60 * 1000; // كل دقيقة
let weeklyContestTickRunning = false;
setInterval(async () => {
  if (weeklyContestTickRunning) return;
  weeklyContestTickRunning = true;
  try {
    const config = await getConfig(process.env);
    await ensureWeeklyContestUpToDate(process.env, config);
  } catch (err) {
    console.error('⚠️ Weekly contest check failed:', err.message);
  } finally {
    weeklyContestTickRunning = false;
  }
}, WEEKLY_CONTEST_CHECK_INTERVAL_MS);
