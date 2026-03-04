// ============================================================
//  BrandSutra AI — Backend Server
//  API key client ko kabhi nahi dikhegi
//  Railway.app pe deploy hoga
// ============================================================

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const Razorpay = require('razorpay');

// Razorpay instance
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Plan IDs from Razorpay Dashboard
const RAZORPAY_PLANS = {
  pro:    'plan_SNDjIwfxc1JJWW',
  agency: 'plan_SNDlAsEe5YKyLo',
};

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: '*' })); // Production mein apna domain daalo

// ── ENV Variables (Railway mein set karo) ──────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Client ko KABHI nahi dikhega
const ADMIN_KEY      = process.env.ADMIN_KEY || 'brandsutra-admin-2025';

// ============================================================
//  IN-MEMORY DATABASE (Production mein MongoDB/PostgreSQL use karo)
//  Railway free plan ke liye ye kaafi hai testing ke liye
// ============================================================
const users = {
  // phone/gmail → user data
  // Example:
  // '+919876543210': { name:'Rahul', plan:'pro', credits:200, token:'abc123', createdAt: Date }
};

const otpStore = {
  // phone → { otp, expiresAt }
};

// ── Plans Config ────────────────────────────────────────────
const PLANS = {
  free:   { credits: 10,   price: 0,    label: 'Free Plan' },
  pro:    { credits: 200,  price: 499,  label: 'Pro Plan' },
  agency: { credits: 1000, price: 1499, label: 'Agency Plan' },
};

// ── Helper: Token generate ──────────────────────────────────
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Helper: Auth middleware ─────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Login required' });

  const user = Object.values(users).find(u => u.token === token);
  if (!user) return res.status(401).json({ error: 'Invalid session. Please login again.' });

  req.user = user;
  next();
}

// ============================================================
//  AUTH ROUTES
// ============================================================

// POST /api/auth/send-otp
// Client phone number bhejta hai, server OTP generate karta hai
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  // 6-digit OTP generate karo
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min

  otpStore[phone] = { otp, expiresAt };

  // =======================================================
  // PRODUCTION MEIN YAHAN MSG91/Twilio se SMS bhejo:
  // await msg91.sendOTP(phone, otp);
  // =======================================================

  console.log(`[OTP] ${phone} → ${otp}`); // Server logs mein dikhega, client ko nahi

  res.json({
    success: true,
    message: 'OTP sent successfully',
    // DEMO MODE: OTP wapas bhej rahe hain — production mein HATAO yeh line
    demo_otp: process.env.NODE_ENV !== 'production' ? otp : undefined,
  });
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp, name } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

  const stored = otpStore[phone];
  if (!stored)             return res.status(400).json({ error: 'OTP request nahi mila. Dobara bhejo.' });
  if (Date.now() > stored.expiresAt) return res.status(400).json({ error: 'OTP expire ho gaya. Dobara bhejo.' });
  if (stored.otp !== otp)  return res.status(400).json({ error: 'Wrong OTP!' });

  // OTP sahi hai — delete karo
  delete otpStore[phone];

  // User create karo ya existing dhundo
  if (!users[phone]) {
    users[phone] = {
      id: makeToken().slice(0, 8),
      phone,
      name: name || 'User',
      plan: 'free',
      credits: PLANS.free.credits,
      token: makeToken(),
      createdAt: new Date().toISOString(),
    };
  } else {
    // Naya token generate karo (security)
    users[phone].token = makeToken();
  }

  const user = users[phone];
  res.json({
    success: true,
    token: user.token,
    user: {
      name: user.name,
      phone: user.phone,
      plan: user.plan,
      credits: user.credits,
      planLabel: PLANS[user.plan]?.label,
    }
  });
});

// POST /api/auth/google
// Google token verify karo (production mein Google OAuth verify karo)
app.post('/api/auth/google', (req, res) => {
  const { email, name, googleId } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const key = 'google_' + email;
  if (!users[key]) {
    users[key] = {
      id: makeToken().slice(0, 8),
      phone: email,
      name: name || email.split('@')[0],
      plan: 'free',
      credits: PLANS.free.credits,
      token: makeToken(),
      createdAt: new Date().toISOString(),
    };
  } else {
    users[key].token = makeToken();
  }

  const user = users[key];
  res.json({
    success: true,
    token: user.token,
    user: {
      name: user.name,
      phone: email,
      plan: user.plan,
      credits: user.credits,
      planLabel: PLANS[user.plan]?.label,
    }
  });
});

// GET /api/auth/me — Current user info
app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    name: u.name,
    phone: u.phone,
    plan: u.plan,
    credits: u.credits,
    planLabel: PLANS[u.plan]?.label,
  });
});

// ============================================================
//  GENERATE ROUTE — API KEY YAHAN CHHUPA HAI
// ============================================================

// POST /api/generate
app.post('/api/generate', requireAuth, async (req, res) => {
  const user = req.user;

  // ── 1. Credits check ──────────────────────────────────────
  if (user.credits <= 0) {
    return res.status(403).json({
      error: 'Credits khatam ho gaye! Plan upgrade karo.',
      upgradeRequired: true,
    });
  }

  // ── 2. Request data ───────────────────────────────────────
  const { tool, bizName, industry, service, audience, location, goal, tone, language } = req.body;
  if (!tool || !bizName) {
    return res.status(400).json({ error: 'Tool aur Business Name required hai' });
  }

  // ── 3. Prompt build karo ──────────────────────────────────
  const systemPrompt = `You are BrandSutra AI, an expert AI marketing strategist for Indian businesses.
Generate persuasive, high-converting ${tool} content based on user inputs.
ALWAYS structure your output with clearly labeled sections:
🎯 HOOK:
❗ PROBLEM:
✅ SOLUTION:
💡 BENEFITS:
📣 CTA:
For social media content, add HASHTAGS section at the end.
Match the selected tone and language precisely.
Use Indian context, rupee symbol, Indian examples naturally.
If language is Hinglish, mix Hindi words naturally.
If Hindi, write in Romanised Hindi (not Devanagari).`;

  const userPrompt = `Generate ${tool} content for:
Business: ${bizName}
Industry: ${industry || 'Business'}
Service/Product: ${service || 'Services'}
Target Audience: ${audience || 'Customers'}
Location: ${location || 'India'}
Goal: ${goal || 'Generate Leads'}
Tone: ${tone || 'Professional'}
Language: ${language || 'English'}

Make it compelling, specific, and ready to use.`;

  // ── 4. OpenAI call — API KEY CLIENT KO KABHI NAHI DIKHEGA ─
  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`, // ← SERVER PE CHHUPA HAI
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.json();
      console.error('[OpenAI Error]', err);
      return res.status(500).json({ error: 'AI service temporarily unavailable. Try again.' });
    }

    const data    = await openaiRes.json();
    const content = data.choices?.[0]?.message?.content || '';

    // ── 5. Credit deduct karo ─────────────────────────────
    user.credits -= 1;

    // ── 6. Response bhejo ─────────────────────────────────
    res.json({
      success: true,
      content,
      creditsLeft: user.credits,
      creditsTotal: PLANS[user.plan]?.credits,
    });

  } catch (err) {
    console.error('[Generate Error]', err.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ============================================================
//  SUBSCRIPTION / PAYMENT ROUTES
// ============================================================

// POST /api/payment/create-subscription — Razorpay subscription banao
app.post('/api/payment/create-subscription', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  // =======================================================
  // PRODUCTION MEIN RAZORPAY SE ORDER CREATE KARO:
  const planId = RAZORPAY_PLANS[plan];
  if (!planId) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const subscription = await razorpay.subscriptions.create({
      plan_id:         planId,
      total_count:     12, // 12 months
      quantity:        1,
      customer_notify: 1,
    });
    return res.json({ subscriptionId: subscription.id, key: process.env.RAZORPAY_KEY_ID });
  } catch (e) {
    console.error('Razorpay error:', e);
    return res.status(500).json({ error: 'Payment creation failed' });
  }
  // res.json({ orderId: order.id, amount: order.amount, currency: 'INR', key: process.env.RAZORPAY_KEY });
  // =======================================================

  // Demo mode
  res.json({
    success: true,
    demo: true,
    plan,
    amount: PLANS[plan].price,
    message: 'Demo mode - Razorpay integration pending',
  });
});

// POST /api/payment/verify — Razorpay signature verify karke plan upgrade karo
app.post('/api/payment/verify', requireAuth, (req, res) => {
  const { plan, paymentId, subscriptionId, signature } = req.body;

  // Signature verify karo
  const body       = paymentId + '|' + subscriptionId;
  const expected   = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
  const isValid    = expected === signature;

  if (!isValid) return res.status(400).json({ error: 'Invalid payment signature' });
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  // Production mein Razorpay signature verify karo
  const user = req.user;
  user.plan    = plan;
  user.credits = PLANS[plan].credits;

  res.json({
    success: true,
    message: `Plan upgraded to ${PLANS[plan].label}!`,
    credits: user.credits,
    plan: user.plan,
  });
});

// ============================================================
//  ADMIN ROUTES (ADMIN_KEY se protected)
// ============================================================

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// GET /api/admin/users — Saare users dekho
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const list = Object.values(users).map(u => ({
    id: u.id, name: u.name, phone: u.phone,
    plan: u.plan, credits: u.credits, createdAt: u.createdAt,
  }));
  res.json({ total: list.length, users: list });
});

// POST /api/admin/add-credits — Manually credits add karo
app.post('/api/admin/add-credits', requireAdmin, (req, res) => {
  const { phone, credits } = req.body;
  if (!users[phone]) return res.status(404).json({ error: 'User not found' });
  users[phone].credits += parseInt(credits);
  res.json({ success: true, newCredits: users[phone].credits });
});

// POST /api/admin/set-plan — Plan manually set karo
app.post('/api/admin/set-plan', requireAdmin, (req, res) => {
  const { phone, plan } = req.body;
  if (!users[phone]) return res.status(404).json({ error: 'User not found' });
  if (!PLANS[plan])   return res.status(400).json({ error: 'Invalid plan' });
  users[phone].plan    = plan;
  users[phone].credits = PLANS[plan].credits;
  res.json({ success: true });
});

// GET /api/health — Server status check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'BrandSutra AI Backend',
    users: Object.keys(users).length,
    timestamp: new Date().toISOString(),
  });
});

// ── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ BrandSutra AI Server running on port ${PORT}`);
  console.log(`🔑 OpenAI key: ${OPENAI_API_KEY ? '✅ Set' : '❌ MISSING - Set OPENAI_API_KEY env variable'}`);
});
