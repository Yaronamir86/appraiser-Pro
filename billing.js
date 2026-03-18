/**
 * ═══════════════════════════════════════════════════════
 *  OMDAN BILLING CORE — v2.0
 *  מערכת חיוב מרכזית לכל מוצרי OMDAN
 *  כל מוצר טוען billing-gate.js שמשתמש ב-BillingCore
 * ═══════════════════════════════════════════════════════
 */

// ── Plans ──
const BILLING_PLANS = {
  trial: {
    id: 'trial',
    label: 'ניסיון חינם',
    days: 14,
    price: 0,
    reportsPerMonth: 5,
    features: ['יצירת דוחות שמאות','העלאת תמונות','הפקת PDF','עד 5 דוחות בחודש','משתמש אחד'],
  },
  starter: {
    id: 'starter',
    label: 'Starter',
    labelHe: 'שמאי עצמאי',
    priceMonthly: 89,
    priceAnnual: 680,
    reportsPerMonth: 20,
    features: ['יצירת דוחות שמאות','העלאת תמונות','הפקת PDF','עד 20 דוחות בחודש','משתמש אחד'],
    stripePriceMonthly: 'price_starter_monthly', // להחליף ב-Stripe
    stripePriceAnnual:  'price_starter_annual',
    popular: false,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    labelHe: 'שמאי פעיל',
    priceMonthly: 129,
    priceAnnual: 990,
    reportsPerMonth: Infinity,
    features: ['דוחות ללא הגבלה','BOQ ומחירונים','אחסון תמונות','חתימה דיגיטלית','ייצוא לאקסל','משתמש אחד'],
    stripePriceMonthly: 'price_pro_monthly',
    stripePriceAnnual:  'price_pro_annual',
    popular: true,
  },
  office: {
    id: 'office',
    label: 'Office',
    labelHe: 'משרד שמאים',
    priceMonthly: 499,
    priceAnnual: 4500,
    reportsPerMonth: Infinity,
    features: ['5 משתמשים','ניהול תיקים','הרשאות עובדים','לוג פעילות','API חיבור למערכות'],
    stripePriceMonthly: 'price_office_monthly',
    stripePriceAnnual:  'price_office_annual',
    popular: false,
  },
};

// ── Product IDs ──
const BILLING_PRODUCTS = {
  APPRAISER_PRO: 'appraiser-pro',
  SMART_VAAD:    'smart-vaad',
};

// ── Firebase Config ──
const BILLING_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAepqvT-NRxTiVemkaxNJWpyAQ9ibxrkcw",
  authDomain: "yaron-appraiser.firebaseapp.com",
  projectId: "yaron-appraiser",
  storageBucket: "yaron-appraiser.firebasestorage.app",
  messagingSenderId: "179370141848",
  appId: "1:179370141848:web:d5843d9641dce3adabc8ed"
};

// ══════════════════════════════════════════════════
// BillingCore
// ══════════════════════════════════════════════════
class BillingCore {

  /**
   * Firestore token structure — /billing/{uid}:
   * {
   *   uid, email, plan: 'trial'|'starter'|'pro'|'office',
   *   products: ['appraiser-pro'],
   *   trialEnd: ISO,
   *   subscriptionEnd: ISO,
   *   reportsThisMonth: number,
   *   reportsResetAt: ISO,
   *   stripeCustomerId, stripeSubscriptionId,
   *   createdAt, updatedAt
   * }
   */

  static async getToken(uid) {
    try {
      const doc = await firebase.firestore().collection('billing').doc(uid).get();
      if (!doc.exists) return null;
      return doc.data();
    } catch(e) {
      console.error('BillingCore.getToken:', e);
      return null;
    }
  }

  static async createTrialToken(uid, email) {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);
    const token = {
      uid, email,
      plan: 'trial',
      products: ['appraiser-pro'],
      trialEnd: trialEnd.toISOString(),
      subscriptionEnd: null,
      reportsThisMonth: 0,
      reportsResetAt: new Date(new Date().getFullYear(), new Date().getMonth()+1, 1).toISOString(),
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await firebase.firestore().collection('billing').doc(uid).set(token);
    return token;
  }

  static checkAccess(token, productId) {
    if (!token) return { ok: false, reason: 'no_token' };
    if (!token.products?.includes(productId)) return { ok: false, reason: 'no_product' };

    const now = new Date();

    // Trial
    if (token.plan === 'trial') {
      const trialEnd = new Date(token.trialEnd);
      if (now > trialEnd) return { ok: false, reason: 'trial_expired' };
      const daysLeft = Math.ceil((trialEnd - now) / 86400000);
      return { ok: true, plan: 'trial', daysLeft };
    }

    // Paid subscription
    if (token.subscriptionEnd) {
      const subEnd = new Date(token.subscriptionEnd);
      if (now > subEnd) return { ok: false, reason: 'subscription_expired' };
      return { ok: true, plan: token.plan };
    }

    return { ok: false, reason: 'unknown' };
  }

  static getDaysLeftInTrial(token) {
    if (!token || token.plan !== 'trial') return null;
    const trialEnd = new Date(token.trialEnd);
    return Math.max(0, Math.ceil((trialEnd - new Date()) / 86400000));
  }

  static getPlanDetails(planId) {
    return BILLING_PLANS[planId] || null;
  }
}

// Export for use in other files
if (typeof module !== 'undefined') module.exports = { BillingCore, BILLING_PLANS, BILLING_PRODUCTS };
