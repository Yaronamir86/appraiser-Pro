/**
 * ═══════════════════════════════════════════════════════
 *  BILLING CORE  —  v1.0
 *  Centralized payment/token system for all SaaS products
 *  by Yaron Amir
 * ═══════════════════════════════════════════════════════
 *
 *  Architecture:
 *  1. User pays via Stripe on billing.html (or embedded)
 *  2. Stripe webhook → Firebase Cloud Function → writes token to Firestore
 *  3. Each SaaS product calls BillingCore.getToken() to validate access
 *  4. Token contains: uid, plan, products[], expiresAt
 *
 *  Products currently using this core:
 *  - appraiser-pro   (מערכת שמאות)
 *  - smart-vaad      (מערכת ועד בית) — future
 *  - [add more here]
 * ═══════════════════════════════════════════════════════
 */

// ── Firebase Config (shared across all products) ──
const BILLING_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAepqvT-NRxTiVemkaxNJWpyAQ9ibxrkcw",
  authDomain: "yaron-appraiser.firebaseapp.com",
  projectId: "yaron-appraiser",
  storageBucket: "yaron-appraiser.firebasestorage.app",
  messagingSenderId: "179370141848",
  appId: "1:179370141848:web:d5843d9641dce3adabc8ed"
};

// ── Product IDs ──
const BILLING_PRODUCTS = {
  APPRAISER_PRO: 'appraiser-pro',
  SMART_VAAD:    'smart-vaad',
  // Add more products here as you build them
};

// ── Plans ──
const BILLING_PLANS = {
  TRIAL:   { id: 'trial',   label: 'ניסיון',    days: 14, price: 0    },
  PRO:     { id: 'pro',     label: 'פרו',       days: 30, price: 99   },
  ANNUAL:  { id: 'annual',  label: 'שנתי',      days: 365, price: 890 },
};

// ── Stripe Price IDs (fill in after creating in Stripe dashboard) ──
const STRIPE_PRICES = {
  'appraiser-pro_monthly': 'price_XXXXXXXXXXXXXX',  // 99₪/month
  'appraiser-pro_annual':  'price_XXXXXXXXXXXXXX',  // 890₪/year
  'smart-vaad_monthly':    'price_XXXXXXXXXXXXXX',
};

// ══════════════════════════════════════════════════
// BillingCore class
// ══════════════════════════════════════════════════
class BillingCore {

  /**
   * Initialize (call once at app start)
   * @param {string} productId - one of BILLING_PRODUCTS values
   */
  static async init(productId) {
    this.productId = productId;
    // Firebase should already be initialized by the host app
    return this;
  }

  // ── TOKEN STRUCTURE (stored in Firestore /billing/{uid}) ──
  // {
  //   uid: string,
  //   email: string,
  //   plan: 'trial' | 'pro' | 'annual',
  //   products: ['appraiser-pro', 'smart-vaad', ...],
  //   trialEnd: ISO string,
  //   subscriptionEnd: ISO string,
  //   stripeCustomerId: string,
  //   stripeSubscriptionId: string,
  //   createdAt: timestamp,
  //   updatedAt: timestamp,
  //   accessToken: string   // JWT-like short token for quick validation
  // }

  /**
   * Get billing token for current user
   * Returns null if no billing record found
   */
  static async getToken(uid) {
    try {
      const doc = await firebase.firestore()
        .collection('billing').doc(uid).get();
      if (!doc.exists) return null;
      return doc.data();
    } catch(e) {
      console.error('BillingCore.getToken error:', e);
      return null;
    }
  }

  /**
   * Check if user has active access to a product
   * @param {string} uid
   * @param {string} productId
   * @returns {object} { hasAccess, plan, reason, daysLeft }
   */
  static async checkAccess(uid, productId) {
    const token = await this.getToken(uid);

    // No billing record → check if new user eligible for trial
    if (!token) {
      return { hasAccess: false, plan: null, reason: 'no_record' };
    }

    const now = new Date();

    // Trial check
    if (token.plan === 'trial') {
      const trialEnd = new Date(token.trialEnd);
      if (now < trialEnd) {
        const daysLeft = Math.ceil((trialEnd - now) / (1000*60*60*24));
        return { hasAccess: true, plan: 'trial', daysLeft, reason: 'trial_active' };
      } else {
        return { hasAccess: false, plan: 'trial', daysLeft: 0, reason: 'trial_expired' };
      }
    }

    // Paid subscription check
    if (token.plan === 'pro' || token.plan === 'annual') {
      const subEnd = new Date(token.subscriptionEnd);
      if (now < subEnd) {
        // Check product is included
        if (!token.products || !token.products.includes(productId)) {
          return { hasAccess: false, plan: token.plan, reason: 'product_not_included' };
        }
        const daysLeft = Math.ceil((subEnd - now) / (1000*60*60*24));
        return { hasAccess: true, plan: token.plan, daysLeft, reason: 'subscription_active' };
      } else {
        return { hasAccess: false, plan: token.plan, daysLeft: 0, reason: 'subscription_expired' };
      }
    }

    return { hasAccess: false, plan: token.plan, reason: 'unknown' };
  }

  /**
   * Create trial record for new user (call on registration)
   * @param {string} uid
   * @param {string} email
   * @param {string} productId
   */
  static async createTrial(uid, email, productId) {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);

    const record = {
      uid,
      email,
      plan: 'trial',
      products: [productId],
      trialEnd: trialEnd.toISOString(),
      subscriptionEnd: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    await firebase.firestore().collection('billing').doc(uid).set(record);
    return record;
  }

  /**
   * Redirect to Stripe Checkout
   * Call this when user clicks "Subscribe" or after trial expires
   * @param {string} priceKey - key in STRIPE_PRICES
   * @param {string} uid
   * @param {string} email
   */
  static redirectToCheckout(priceKey, uid, email) {
    const priceId = STRIPE_PRICES[priceKey];
    if (!priceId || priceId.startsWith('price_XXXX')) {
      // TODO: replace with actual Stripe payment link
      alert('מערכת התשלום בהקמה — צור קשר: 050-3292066');
      return;
    }
    // When Stripe is live, use Stripe.js:
    // const stripe = Stripe('pk_live_XXXX');
    // stripe.redirectToCheckout({ lineItems: [{price: priceId, quantity: 1}], ... });
    console.log('Stripe checkout:', priceId, uid, email);
  }

  /**
   * Show access denied UI
   * Call this when checkAccess returns hasAccess=false
   * @param {object} accessResult - result from checkAccess()
   * @param {string} containerSelector - where to inject the UI
   */
  static showAccessDenied(accessResult, containerSelector = 'body') {
    const messages = {
      trial_expired: {
        title: 'תקופת הניסיון הסתיימה',
        body: '14 ימי הניסיון החינמי הסתיימו. שדרג לפלאן פרו להמשך גישה.',
        cta: 'שדרג לפרו — 99₪/חודש',
        action: () => BillingCore.redirectToCheckout('appraiser-pro_monthly', firebase.auth().currentUser?.uid, firebase.auth().currentUser?.email)
      },
      subscription_expired: {
        title: 'המנוי פג תוקף',
        body: 'המנוי שלך פג. חדש אותו כדי להמשיך.',
        cta: 'חדש מנוי',
        action: () => BillingCore.redirectToCheckout('appraiser-pro_monthly', firebase.auth().currentUser?.uid, firebase.auth().currentUser?.email)
      },
      no_record: {
        title: 'ברוך הבא!',
        body: 'התחל 14 ימי ניסיון חינם — ללא כרטיס אשראי.',
        cta: 'התחל ניסיון חינם',
        action: () => location.href = 'register.html'
      }
    };

    const msg = messages[accessResult.reason] || messages['no_record'];

    const overlay = document.createElement('div');
    overlay.id = 'billing-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(3,7,18,.95);z-index:9999;
      display:flex;align-items:center;justify-content:center;
      font-family:'Heebo',sans-serif;direction:rtl;
    `;
    overlay.innerHTML = `
      <div style="background:#111827;border:1px solid rgba(245,158,11,.3);border-radius:24px;padding:48px 40px;max-width:420px;width:90%;text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">⚖️</div>
        <h2 style="color:#f9fafb;font-size:24px;font-weight:900;margin-bottom:12px;">${msg.title}</h2>
        <p style="color:#9ca3af;font-size:15px;line-height:1.6;margin-bottom:28px;">${msg.body}</p>
        <button onclick="(${msg.action.toString()})()" style="
          width:100%;background:linear-gradient(135deg,#f59e0b,#d97706);
          color:#000;border:none;border-radius:12px;padding:14px;
          font-size:16px;font-weight:800;cursor:pointer;font-family:'Heebo',sans-serif;
          margin-bottom:12px;
        ">${msg.cta}</button>
        <a href="saas-landing.html" style="color:#6b7280;font-size:13px;display:block;">לדף הבית</a>
      </div>
    `;
    document.querySelector(containerSelector).appendChild(overlay);
  }

  /**
   * Show trial banner (add to top of app when trial active)
   * @param {object} accessResult
   */
  static showTrialBanner(accessResult) {
    if (accessResult.plan !== 'trial' || !accessResult.hasAccess) return;
    const banner = document.createElement('div');
    banner.id = 'trial-banner';
    banner.style.cssText = `
      background:rgba(245,158,11,.12);border-bottom:1px solid rgba(245,158,11,.25);
      padding:8px 24px;text-align:center;font-family:'Heebo',sans-serif;
      direction:rtl;font-size:13px;color:#fcd34d;font-weight:600;
      position:relative;z-index:50;
    `;
    banner.innerHTML = `
      ⏰ <strong>ניסיון חינם</strong> — נותרו ${accessResult.daysLeft} ימים
      &nbsp;|&nbsp;
      <a href="#" onclick="BillingCore.redirectToCheckout('appraiser-pro_monthly')" style="color:#f59e0b;text-decoration:underline;">שדרג עכשיו</a>
      &nbsp;|&nbsp;
      <a href="saas-landing.html" style="color:#9ca3af;text-decoration:none;">מידע על התוכניות</a>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
  }
}

// Export for use in other files
if (typeof module !== 'undefined') module.exports = { BillingCore, BILLING_PRODUCTS, BILLING_PLANS };
