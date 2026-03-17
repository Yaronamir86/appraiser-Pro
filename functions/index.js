/**
 * OMDAN — Firebase Cloud Functions v2.1
 *
 * Secrets (הגדר פעם אחת):
 *   firebase functions:secrets:set CARDCOM_TERMINAL
 *   firebase functions:secrets:set CARDCOM_USERNAME
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const https = require("https");
const querystring = require("querystring");

admin.initializeApp();
const db = admin.firestore();

// ══ Secrets — credentials לא בקוד ══
// API 10 (Name-to-Value) משתמש רק ב-TerminalNumber + UserName.
// אין שדה Password ב-API 10. הסיסמה היא לפאנל הניהול בלבד.
const CARDCOM_TERMINAL = defineSecret("CARDCOM_TERMINAL");
const CARDCOM_USERNAME = defineSecret("CARDCOM_USERNAME");

const CARDCOM_URLS = {
  lowProfile: "https://secure.cardcom.solutions/Interface/LowProfile.aspx",
  indicator:
    "https://secure.cardcom.solutions/Interface/BillGoldGetLowProfileIndicator.aspx",
  chargeToken:
    "https://secure.cardcom.solutions/Interface/BillGoldService.asmx",
  successUrl:
    "https://yaronamir86.github.io/appraiser-Pro/billing-success.html",
  errorUrl: "https://yaronamir86.github.io/appraiser-Pro/billing-error.html",
  webhookUrl:
    "https://us-central1-yaron-appraiser.cloudfunctions.net/cardcomWebhook",
};

const PLANS = {
  starter: { monthly: 129, annual: 990, name: "OMDAN Starter" },
  pro: { monthly: 249, annual: 2190, name: "OMDAN Pro" },
  office: { monthly: 499, annual: 4500, name: "OMDAN Office" },
};

// ── Helpers ──────────────────────────────────────
function httpPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(params);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      })
      .on("error", reject);
  });
}

function parseNV(str) {
  const r = {};
  str.split("&").forEach((p) => {
    const [k, ...v] = p.split("=");
    if (k) r[decodeURIComponent(k)] = decodeURIComponent(v.join("=") || "");
  });
  return r;
}

function calcEnd(billingMode, from = new Date()) {
  const d = new Date(from);
  if (billingMode === "annual") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

// ════════════════════════════════════════════════════════
//  Function 1: cardcomCreatePayment
//  יוצר checkout session + דף תשלום בקארדקום
// ════════════════════════════════════════════════════════
exports.cardcomCreatePayment = onRequest(
  { region: "us-central1", secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      // אמת Firebase token
      const authHeader = req.headers.authorization || "";
      if (!authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      let uid, email;
      try {
        const decoded = await admin
          .auth()
          .verifyIdToken(authHeader.replace("Bearer ", ""));
        uid = decoded.uid;
        email = decoded.email || "";
      } catch {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { planId, billingMode } = req.body || {};
      if (!planId || !billingMode) {
        res.status(400).json({ error: "Missing params" });
        return;
      }

      const planData = PLANS[planId];
      if (!planData || !["monthly", "annual"].includes(billingMode)) {
        res.status(400).json({ error: "Invalid planId or billingMode" });
        return;
      }

      const amount =
        billingMode === "annual" ? planData.annual : planData.monthly;
      const productName = planData.name;

      // צור checkout session
      const sessionRef = db.collection("checkoutSessions").doc();
      const sessionId = sessionRef.id;

      await sessionRef.set({
        uid,
        planId,
        billingMode,
        amount,
        productName,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const terminal = CARDCOM_TERMINAL.value();
      const username = CARDCOM_USERNAME.value();

      const params = {
        TerminalNumber: terminal,
        UserName: username,
        APILevel: "10",
        Operation: "2",
        CoinId: "1",
        Language: "he",
        Codepage: "65001",
        SumToBill: String(amount),
        ProductName: productName,
        CardOwnerEmail: email,
        SuccessRedirectUrl: `${CARDCOM_URLS.successUrl}?session=${sessionId}`,
        ErrorRedirectUrl: `${CARDCOM_URLS.errorUrl}?session=${sessionId}`,
        IndicatorUrl: CARDCOM_URLS.webhookUrl,
        ReturnValue: sessionId,
        InvoiceHeadOperation: "1",
        DocTypeToCreate: "400",
        "InvoiceHead.CustName": productName,
        "InvoiceHead.Email": email,
        "InvoiceHead.SendByEmail": "true",
        "InvoiceHead.Language": "he",

        "InvoiceLines1.Description": productName,
        "InvoiceLines1.Price": String(amount),
        "InvoiceLines1.Quantity": "1",
        AutoRedirect: "false",
      };

      logger.info("Creating payment", {
        uid,
        planId,
        billingMode,
        amount,
        sessionId,
      });
      
      logger.info("Cardcom URLs", CARDCOM_URLS);
      logger.info("Cardcom params", params);

      const raw = await httpPost(CARDCOM_URLS.lowProfile, params);
      const parsed = parseNV(raw);

      if (parsed.ResponseCode !== "0") {
        await sessionRef.update({
          status: "failed",
          error: parsed.Description || parsed.ResponseCode || "Cardcom error",
        });
        throw new Error(
          `Cardcom: ${parsed.Description || parsed.ResponseCode || "Unknown error"}`,
        );
      }

      await sessionRef.update({
        lowProfileCode: parsed.LowProfileCode || null,
      });

      res.json({
        url: parsed.Url || parsed.url,
        sessionId,
      });
    } catch (e) {
      logger.error("cardcomCreatePayment", e);
      res.status(500).json({ error: e.message });
    }
  },
);

// ════════════════════════════════════════════════════════
//  Function 2: cardcomWebhook
//  מקבל אישור מקארדקום — idempotency אטומי עם Transaction
// ════════════════════════════════════════════════════════
exports.cardcomWebhook = onRequest(
  { region: "us-central1", secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME] },
  async (req, res) => {
    try {
      logger.info("cardcomWebhook HIT", {
        method: req.method,
        query: req.query || null,
        body: req.body || null,
        headers: req.headers || null,
      });

      let bodyData = {};

if (typeof req.body === "object" && req.body) {
  bodyData = req.body;
} else if (typeof req.body === "string" && req.body) {
  bodyData = querystring.parse(req.body);
}

const source = {
  ...(req.query || {}),
  ...(bodyData || {}),
};

      const terminalnumber =
        source.terminalnumber ||
        source.TerminalNumber ||
        source.terminalNumber;

      const lowprofilecode =
        source.lowprofilecode ||
        source.LowProfileCode ||
        source.lowProfileCode;

      const ReturnValue =
        source.ReturnValue ||
        source.returnvalue ||
        source.returnValue ||
        source.session;

      logger.info("Webhook normalized params", {
        terminalnumber,
        lowprofilecode,
        ReturnValue,
      });

      if (!lowprofilecode || !terminalnumber) {
  logger.warn("Webhook missing critical params", {
    terminalnumber,
    lowprofilecode,
    ReturnValue,
    rawQuery: req.query || null,
    rawBody: req.body || null,
  });
  res.status(200).send("ok");
  return;
}

let sessionId = ReturnValue ? String(ReturnValue).trim() : null;
let sessionRef = null;
let sessionSnap = null;

if (sessionId) {
  sessionRef = db.collection("checkoutSessions").doc(sessionId);
  sessionSnap = await sessionRef.get();
}

if ((!sessionSnap || !sessionSnap.exists) && lowprofilecode) {
  const byLowProfile = await db
    .collection("checkoutSessions")
    .where("lowProfileCode", "==", lowprofilecode)
    .limit(1)
    .get();

  if (!byLowProfile.empty) {
    sessionSnap = byLowProfile.docs[0];
    sessionRef = sessionSnap.ref;
    sessionId = sessionSnap.id;
    logger.info("Session resolved by lowProfileCode", {
      sessionId,
      lowprofilecode,
    });
  }
}

if (!sessionSnap || !sessionSnap.exists) {
  logger.warn("Session not found", {
    sessionId,
    lowprofilecode,
    ReturnValue,
  });
  res.status(200).send("ok");
  return;
}

      const sessionId = String(ReturnValue).trim();
      const sessionRef = db.collection("checkoutSessions").doc(sessionId);

      const sessionSnap = await sessionRef.get();
      if (!sessionSnap.exists) {
        logger.warn("Session not found", { sessionId });
        res.status(200).send("ok");
        return;
      }

      const session = sessionSnap.data();
      if (session.status === "paid") {
        logger.info("Duplicate webhook (session already paid)", { sessionId });
        res.status(200).send("ok");
        return;
      }

      const username = CARDCOM_USERNAME.value();
      const verifyUrl =
        `${CARDCOM_URLS.indicator}?terminalnumber=${encodeURIComponent(terminalnumber)}` +
        `&username=${encodeURIComponent(username)}` +
        `&lowprofilecode=${encodeURIComponent(lowprofilecode)}`;

      logger.info("Cardcom verify URL prepared", {
        terminalnumber,
        lowprofilecode,
        sessionId,
      });

      const verifyRaw = await httpGet(verifyUrl);
      const verified = parseNV(verifyRaw);

      logger.info("Cardcom verify response", {
        op: verified.OperationResponse,
        deal: verified.DealResponse,
        internalDealNumber: verified.InternalDealNumber || null,
        token: verified.Token || null,
      });

      if (verified.OperationResponse !== "0" || verified.DealResponse !== "0") {
        await sessionRef.update({ status: "failed" });
        logger.warn("Payment verification failed", verified);
        res.status(200).send("ok");
        return;
      }

      const dealNumber = verified.InternalDealNumber;
      if (!dealNumber) {
        logger.error("No InternalDealNumber from Cardcom", verified);
        res.status(200).send("ok");
        return;
      }

      const payRef = db.collection("payments").doc(String(dealNumber));

      const DUPLICATE = "DUPLICATE_PAYMENT";
      try {
        await db.runTransaction(async (t) => {
          const paySnap = await t.get(payRef);
          if (paySnap.exists) {
            const err = new Error(DUPLICATE);
            err.code = DUPLICATE;
            throw err;
          }

          t.set(payRef, {
            sessionId,
            uid: session.uid,
            planId: session.planId,
            amount: session.amount,
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          t.update(sessionRef, {
            status: "paid",
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            planId: session.planId,
            billingMode: session.billingMode,
          });
        });
      } catch (e) {
        if (e.code === DUPLICATE || e.message === DUPLICATE) {
          logger.info("Atomic duplicate detected", { dealNumber });
          res.status(200).send("ok");
          return;
        }
        throw e;
      }

      const { uid, planId, billingMode } = session;
      const plan = PLANS[planId];
      if (!plan) {
        logger.warn("Plan not found for billing", { uid, planId, sessionId });
        res.status(200).send("ok");
        return;
      }

      const now = new Date();
      const subEnd = calcEnd(billingMode, now);

      await db.collection("billing").doc(uid).set(
        {
          plan: planId,
          billingMode,
          status: "active",
          subscriptionStart: admin.firestore.Timestamp.fromDate(now),
          subscriptionEnd: admin.firestore.Timestamp.fromDate(subEnd),
          lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
          lastPaymentAmount:
            billingMode === "annual" ? plan.annual : plan.monthly,
          cardcomToken: verified.Token || null,
          cardcomTokenExp: verified.TokenExDate || null,
          cardcomDealNumber: dealNumber || null,
          reportsThisMonth: 0,
          reportsResetAt: admin.firestore.Timestamp.fromDate(subEnd),
        },
        { merge: true },
      );

      logger.info("Payment processed OK", {
        uid,
        planId,
        billingMode,
        dealNumber,
        sessionId,
      });

      res.status(200).send("ok");
    } catch (e) {
      logger.error("cardcomWebhook error", {
        message: e?.message || String(e),
        stack: e?.stack || null,
      });
      res.status(200).send("ok");
    }
  },
);

// ════════════════════════════════════════════════════════
//  Function 3: cardcomRenewSubscriptions (Scheduled)
//  חיוב מתחדש — Scheduler בלבד, לקוח לא יכול להפעיל
//  רץ 09:00 כל יום (ישראל)
// ════════════════════════════════════════════════════════
exports.cardcomRenewSubscriptions = onSchedule(
  {
    schedule: "0 9 * * *",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    secrets: [CARDCOM_TERMINAL, CARDCOM_USERNAME],
  },
  async () => {
    const terminal = CARDCOM_TERMINAL.value();
    const username = CARDCOM_USERNAME.value();

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const snap = await db
      .collection("billing")
      .where("status", "==", "active")
      .where("subscriptionEnd", ">=", admin.firestore.Timestamp.fromDate(now))
      .where(
        "subscriptionEnd",
        "<",
        admin.firestore.Timestamp.fromDate(tomorrow),
      )
      .get();

    logger.info(`Renewing ${snap.size} subscriptions`);

    for (const docSnap of snap.docs) {
      const uid = docSnap.id;
      const b = docSnap.data();

      if (!b.cardcomToken) {
        logger.warn("No token", { uid });
        continue;
      }

      const plan = PLANS[b.plan];
      if (!plan) continue;

      const amount = b.billingMode === "annual" ? plan.annual : plan.monthly;

      try {
        const raw = await httpPost(
          `${CARDCOM_URLS.chargeToken}?op=DoTransaction`,
          {
            TerminalNumber: terminal,
            UserName: username,
            Token: b.cardcomToken,
            TokenExDate: b.cardcomTokenExp,
            SumToBill: String(amount),
            CoinId: "1",
            Operation: "1",
            ProductName: `${plan.name} — חידוש`,
          },
        );

        const parsed = parseNV(raw);

        if (parsed.ResponseCode === "0" && parsed.OperationResponse === "0") {
          const dealNum = parsed.InternalDealNumber;
          const newEnd = calcEnd(b.billingMode, b.subscriptionEnd.toDate());

          // Atomic idempotency גם לחידושים
          const payRef = db.collection("payments").doc(String(dealNum));
          const DUPLICATE = "DUPLICATE_RENEWAL";

          try {
            await db.runTransaction(async (t) => {
              const paySnap = await t.get(payRef);
              if (paySnap.exists) {
                const e = new Error(DUPLICATE);
                e.code = DUPLICATE;
                throw e;
              }

              t.set(payRef, {
                uid,
                planId: b.plan,
                amount,
                type: "renewal",
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            });
          } catch (e) {
            if (e.code === DUPLICATE) {
              logger.info("Duplicate renewal skipped", { dealNum });
              continue;
            }
            throw e;
          }

          await db
            .collection("billing")
            .doc(uid)
            .update({
              status: "active",
              subscriptionEnd: admin.firestore.Timestamp.fromDate(newEnd),
              lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
              lastPaymentAmount: amount,
              reportsThisMonth: 0,
            });

          logger.info("Renewal OK", { uid, newEnd });
        } else {
          await db
            .collection("billing")
            .doc(uid)
            .update({
              status: "renewal_failed",
              renewalError: parsed.Description || parsed.ResponseCode,
            });

          logger.warn("Renewal failed", { uid, err: parsed.Description });
        }
      } catch (e) {
        logger.error("Renewal error", { uid, err: e.message });
      }
    }
  },
);
