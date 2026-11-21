const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Database (Data Storage)
const reports = [];
const locationShares = new Map();
const reportVerificationChallenges = new Map();
const reportOtpSendLimits = new Map();
const REPORT_OTP_TTL_MS = 5 * 60 * 1000;
const REPORT_OTP_MAX_ATTEMPTS = 5;
const REPORT_OTP_MAX_ACTIVE = 1000;
const REPORT_OTP_SEND_COOLDOWN_MS = 60 * 1000;
const REPORT_OTP_SEND_WINDOW_MS = 60 * 60 * 1000;
const REPORT_OTP_MAX_SENDS_PER_WINDOW = 5;
const REPORT_OTP_MAX_SENDS_PER_IP_WINDOW = 10;

function hashReportOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest();
}

function normalizePhoneNumber(phone) {
  if (typeof phone !== 'string') return null;
  const normalized = phone.trim().replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

function getActiveLocationShare(token) {
  const share = locationShares.get(token);
  if (!share) return null;
  if (share.expiresAt <= Date.now()) {
    locationShares.delete(token);
    return null;
  }
  return share;
}

function parseCoordinates(body) {
  body = body || {};
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return null;
  }
  return { latitude, longitude };
}

function getLocalIpv4Addresses() {
  const interfaces = Object.entries(os.networkInterfaces());
  const addresses = interfaces.flatMap(([name, entries]) =>
    (entries || [])
      .filter(entry =>
        (entry.family === 'IPv4' || entry.family === 4) &&
        !entry.internal &&
        !entry.address.startsWith('169.254.'))
      .map(entry => ({ name, address: entry.address }))
  );
  const privateAddressPriority = address => {
    if (/^192\.168\./.test(address)) return 0;
    if (/^10\./.test(address)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
    return 3;
  };
  const interfacePriority = name =>
    /virtual|vpn|tunnel|docker|wsl|bluetooth/i.test(name) ? 1 : 0;

  return addresses
    .sort((first, second) =>
      interfacePriority(first.name) - interfacePriority(second.name) ||
      privateAddressPriority(first.address) - privateAddressPriority(second.address)
    )
    .map(entry => entry.address);
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127\./.test(normalized);
}

function removeExpiredReportOtpChallenges(now = Date.now()) {
  for (const [challengeId, challenge] of reportVerificationChallenges) {
    if (challenge.expiresAt <= now) reportVerificationChallenges.delete(challengeId);
  }
}

function getReportOtpSendRateKey(scope, value) {
  return crypto.createHash('sha256').update(`${scope}:${value}`).digest('hex');
}

function getReportOtpSendRetryAfter(rateKey, maxSends, now = Date.now()) {
  for (const [key, limit] of reportOtpSendLimits) {
    if (now - limit.windowStartedAt >= REPORT_OTP_SEND_WINDOW_MS) {
      reportOtpSendLimits.delete(key);
    }
  }

  const limit = reportOtpSendLimits.get(rateKey);
  if (!limit) return 0;
  if (limit.sendCount >= maxSends) {
    return Math.ceil((limit.windowStartedAt + REPORT_OTP_SEND_WINDOW_MS - now) / 1000);
  }
  if (now - limit.lastSentAt < REPORT_OTP_SEND_COOLDOWN_MS) {
    return Math.ceil((limit.lastSentAt + REPORT_OTP_SEND_COOLDOWN_MS - now) / 1000);
  }
  return 0;
}

function recordReportOtpSend(rateKey, now = Date.now()) {
  let limit = reportOtpSendLimits.get(rateKey);
  if (!limit || now - limit.windowStartedAt >= REPORT_OTP_SEND_WINDOW_MS) {
    limit = { windowStartedAt: now, lastSentAt: 0, sendCount: 0 };
  }
  limit.lastSentAt = now;
  limit.sendCount += 1;
  reportOtpSendLimits.set(rateKey, limit);
}

// Keywords for NLP/AI Extraction Mocking
const CATEGORY_KEYWORDS = {
  'Harassment': ['follow', 'catcall', 'harass', 'stalk', 'staring', 'uncomfortable'],
  'Lighting/Infrastructure': ['dark', 'street light', 'broken light', 'cctv', 'lonely road'],
  'Transport Safety': ['cab', 'bus', 'auto', 'driver', 'route'],
  'Public Spaces': ['park', 'station', 'market', 'crowd']
};

// --- AI ANALYSIS ENGINE ---
function analyzeReportText(description) {
  const text = description.toLowerCase();
  
  // 1. Category Detection
  let detectedCategory = 'General Concern';
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      detectedCategory = category;
      break;
    }
  }

  // 2. Risk Level Calculation
  let securityLevel = 'Low Concern';
  if (text.includes('follow') || text.includes('stalk') || text.includes('threat') || text.includes('weapon')) {
    securityLevel = 'High Concern';
  } else if (text.includes('dark') || text.includes('isolated') || text.includes('uncomfortable')) {
    securityLevel = 'Moderate Concern';
  }

  // 3. Generative Recommendations
  let recommendation = 'Stay in well-lit areas and keep emergency contacts on speed dial.';
  if (securityLevel === 'High Concern') {
    recommendation = 'Avoid walking alone in this area during night hours. Immediate patrol suggested.';
  } else if (detectedCategory === 'Lighting/Infrastructure') {
    recommendation = 'Report missing lighting fixtures to local municipal authorities.';
  }

  return {
    category: detectedCategory,
    securityLevel: securityLevel,
    recommendation: recommendation
  };
}

// --- ROUTES ---

app.get('/api/location-share-access', (req, res) => {
  const localAddress = isLoopbackHostname(req.hostname)
    ? getLocalIpv4Addresses()[0]
    : null;

  res.set('Cache-Control', 'no-store');
  res.json({
    localNetworkOrigin: localAddress ? `http://${localAddress}:${PORT}` : null
  });
});

app.post('/api/report-otp/send', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(503).json({
      error: 'OTP log delivery is disabled in production. Configure an SMS provider before deploying.'
    });
  }

  const phone = normalizePhoneNumber(req.body && req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Enter a valid phone number in international format, such as +919876543210.' });
  }

  const now = Date.now();
  removeExpiredReportOtpChallenges(now);
  if (reportVerificationChallenges.size >= REPORT_OTP_MAX_ACTIVE) {
    return res.status(429).json({ error: 'Verification is temporarily busy. Please try again shortly.' });
  }

  const phoneRateKey = getReportOtpSendRateKey('phone', phone);
  const ipRateKey = getReportOtpSendRateKey('ip', req.ip || req.socket.remoteAddress || 'unknown');
  const retryAfterSeconds = Math.max(
    getReportOtpSendRetryAfter(phoneRateKey, REPORT_OTP_MAX_SENDS_PER_WINDOW, now),
    getReportOtpSendRetryAfter(ipRateKey, REPORT_OTP_MAX_SENDS_PER_IP_WINDOW, now)
  );
  if (retryAfterSeconds > 0) {
    return res.status(429).json({
      error: `Please wait ${retryAfterSeconds} seconds before requesting another OTP.`,
      retryAfterSeconds
    });
  }
  recordReportOtpSend(phoneRateKey, now);
  recordReportOtpSend(ipRateKey, now);

  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + REPORT_OTP_TTL_MS;
  for (const [existingId, challenge] of reportVerificationChallenges) {
    if (challenge.phone === phone) reportVerificationChallenges.delete(existingId);
  }

  const challengeId = crypto.randomBytes(24).toString('hex');
  console.log(`[DEV ONLY] SAFIRA report OTP challenge ${challengeId}: ${code}`);

  reportVerificationChallenges.set(challengeId, {
    phone,
    codeHash: hashReportOtp(code),
    attempts: 0,
    verified: false,
    expiresAt
  });

  res.set('Cache-Control', 'no-store');
  res.status(201).json({ challengeId, expiresAt });
});

app.post('/api/report-otp/verify', (req, res) => {
  const body = req.body || {};
  const challengeId = body.challengeId;
  const otp = body.otp;
  if (typeof challengeId !== 'string' || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: 'Enter the six-digit OTP sent to your phone.' });
  }

  const challenge = reportVerificationChallenges.get(challengeId);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    reportVerificationChallenges.delete(challengeId);
    return res.status(410).json({ error: 'This OTP has expired. Request a new one.' });
  }
  if (challenge.verified) {
    return res.status(409).json({ error: 'This phone number is already verified for this report.' });
  }
  if (challenge.attempts >= REPORT_OTP_MAX_ATTEMPTS) {
    reportVerificationChallenges.delete(challengeId);
    return res.status(410).json({ error: 'Too many incorrect attempts. Request a new OTP.' });
  }

  challenge.attempts += 1;
  const isValid = crypto.timingSafeEqual(challenge.codeHash, hashReportOtp(otp));

  if (!isValid) {
    if (challenge.attempts >= REPORT_OTP_MAX_ATTEMPTS) {
      reportVerificationChallenges.delete(challengeId);
      return res.status(410).json({ error: 'Too many incorrect attempts. Request a new OTP.' });
    }
    return res.status(400).json({ error: 'That OTP is incorrect. Check the message and try again.' });
  }

  challenge.verified = true;
  res.set('Cache-Control', 'no-store');
  res.json({ verified: true });
});

// Temporary, token-protected location shares stay in memory and expire automatically.
app.post('/api/location-shares', (req, res) => {
  const body = req.body || {};
  const coordinates = parseCoordinates(body);
  const durationMinutes = Number(body.durationMinutes);
  if (!coordinates || ![15, 30, 60].includes(durationMinutes)) {
    return res.status(400).json({ error: 'Valid coordinates and a supported duration are required.' });
  }

  const now = Date.now();
  for (const [token, share] of locationShares) {
    if (share.expiresAt <= now) locationShares.delete(token);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const share = {
    ...coordinates,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + durationMinutes * 60 * 1000
  };
  locationShares.set(token, share);
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ token, expiresAt: share.expiresAt });
});

app.put('/api/location-shares/:token/location', (req, res) => {
  const share = getActiveLocationShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'This location share has expired or stopped.' });

  const coordinates = parseCoordinates(req.body);
  if (!coordinates) return res.status(400).json({ error: 'Valid coordinates are required.' });

  Object.assign(share, coordinates, { updatedAt: Date.now() });
  res.set('Cache-Control', 'no-store');
  res.json({ expiresAt: share.expiresAt, updatedAt: share.updatedAt });
});

app.get('/api/location-shares/:token', (req, res) => {
  const share = getActiveLocationShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'This location share has expired or stopped.' });

  res.set('Cache-Control', 'no-store');
  res.json({
    latitude: share.latitude,
    longitude: share.longitude,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
    expiresAt: share.expiresAt
  });
});

app.delete('/api/location-shares/:token', (req, res) => {
  locationShares.delete(req.params.token);
  res.sendStatus(204);
});

// Submit Report & Process AI Pipeline
app.post('/api/reports', (req, res) => {
  const body = req.body || {};
  const { reporterType, description, time, verificationChallengeId } = body;
  const coordinates = parseCoordinates(body);

  if (typeof description !== 'string' || !description.trim() || !coordinates) {
    return res.status(400).json({ error: 'Missing required report fields.' });
  }

  const verificationChallenge = reportVerificationChallenges.get(verificationChallengeId);
  if (!verificationChallenge || verificationChallenge.expiresAt <= Date.now()) {
    reportVerificationChallenges.delete(verificationChallengeId);
    return res.status(410).json({ error: 'Phone verification expired. Send and verify a new OTP.' });
  }
  if (!verificationChallenge.verified) {
    return res.status(403).json({ error: 'Verify your phone before submitting this report.' });
  }
  reportVerificationChallenges.delete(verificationChallengeId);

  // AI Analysis Step
  const aiAnalysis = analyzeReportText(description);

  const reportRecord = {
    id: 'SAF-' + Date.now().toString().slice(-5),
    reporterType: reporterType || 'General', // women, child, student, etc.
    description: description.trim(),
    location: {
      lat: coordinates.latitude,
      lng: coordinates.longitude
    },
    time: time || new Date().toISOString(),
    aiAnalysis,
    timestamp: new Date()
  };

  reports.push(reportRecord);

  res.status(201).json({
    message: 'Report filed. Your phone number is not attached to the report.',
    aiOutput: reportRecord
  });
});

// AI Safety Dashboard & Pattern Detection Analytics
app.get('/api/dashboard', (req, res) => {
  const totalReports = reports.length;

  // Most Reported Concerns & Risk Breakdown
  const categoryCounts = {};
  const riskCounts = { 'High Concern': 0, 'Moderate Concern': 0, 'Low Concern': 0 };

  reports.forEach(r => {
    const cat = r.aiAnalysis.category;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;

    const risk = r.aiAnalysis.securityLevel;
    if (riskCounts[risk] !== undefined) {
      riskCounts[risk]++;
    }
  });

  // AI Generated Insights / Pattern Detection
  let insights = ['Insufficient data for pattern detection.'];
  let recommendedActions = ['Continue monitoring phone-verified submissions.'];

  if (totalReports > 0) {
    const highRiskCount = riskCounts['High Concern'];
    if (highRiskCount > 0) {
      insights = [
        `Detected ${highRiskCount} high-risk hotspot alert(s) in local zones.`,
        `Night-time concerns show an elevated safety gap near unlit streets.`
      ];
      recommendedActions = [
        'Deploy targeted night patrolling in identified high-concern zones.',
        'Request municipal lighting maintenance in reported dark spots.'
      ];
    } else {
      insights = ['Area activity reports low-to-moderate concern levels overall.'];
      recommendedActions = ['Maintain active community awareness reporting.'];
    }
  }

  res.json({
    totalReports,
    categoryCounts,
    riskCounts,
    aiGeneratedInsights: insights,
    recommendedActions: recommendedActions,
    zones: [],
    reports: reports
  });
});

app.listen(PORT, () => {
  console.log(`SAFIRA Server running on http://localhost:${PORT}`);
});