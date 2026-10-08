const express = require('express');
const cors = require('cors');
const path = require('path');
const { randomBytes } = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Database (Data Storage)
const reports = [];
const liveLocationShares = new Map();
const shareRequestTimes = new Map();
const LIVE_SHARE_DURATION_MS = 60 * 60 * 1000;

function parseCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

function getActiveShare(token) {
  const share = liveLocationShares.get(token);
  if (!share) return null;
  if (share.expiresAt <= Date.now()) {
    liveLocationShares.delete(token);
    return null;
  }
  return share;
}

async function sendLocationAlert(phoneNumber, shareUrl) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, PUBLIC_BASE_URL } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !PUBLIC_BASE_URL) {
    return { sent: false, configured: false };
  }

  const message = `A trusted contact shared their live location with you: ${shareUrl} (link expires in 1 hour).`;
  const form = new URLSearchParams({ To: phoneNumber, From: TWILIO_PHONE_NUMBER, Body: message });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });
  return { sent: response.ok, configured: true };
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

app.post('/api/location-shares', async (req, res) => {
  const { phoneNumber } = req.body;
  const coordinates = parseCoordinates(req.body.latitude, req.body.longitude);
  if (typeof phoneNumber !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phoneNumber) || !coordinates) {
    return res.status(400).json({ error: 'Enter an international phone number and a valid current location.' });
  }

  const requestKey = req.ip;
  const recentRequests = (shareRequestTimes.get(requestKey) || []).filter(time => Date.now() - time < 60 * 60 * 1000);
  if (recentRequests.length >= 3) {
    return res.status(429).json({ error: 'Sharing has been started too many times. Please try again later.' });
  }
  recentRequests.push(Date.now());
  shareRequestTimes.set(requestKey, recentRequests);

  const token = randomBytes(24).toString('hex');
  const expiresAt = Date.now() + LIVE_SHARE_DURATION_MS;
  liveLocationShares.set(token, { ...coordinates, updatedAt: Date.now(), expiresAt });

  const baseUrl = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const shareUrl = `${baseUrl}/share/${token}`;
  let alert = { sent: false, configured: false };
  try {
    alert = await sendLocationAlert(phoneNumber, shareUrl);
  } catch (error) {
    console.error('Unable to send live-location SMS alert:', error.message);
    alert = { sent: false, configured: true };
  }

  res.status(201).json({ token, shareUrl, expiresAt: new Date(expiresAt).toISOString(), ...alert });
});

app.put('/api/location-shares/:token', (req, res) => {
  const share = getActiveShare(req.params.token);
  const coordinates = parseCoordinates(req.body.latitude, req.body.longitude);
  if (!share) return res.status(410).json({ error: 'This location link has expired or sharing has stopped.' });
  if (!coordinates) return res.status(400).json({ error: 'Invalid location coordinates.' });
  Object.assign(share, coordinates, { updatedAt: Date.now() });
  res.json({ updatedAt: new Date(share.updatedAt).toISOString() });
});

app.get('/api/location-shares/:token', (req, res) => {
  const share = getActiveShare(req.params.token);
  if (!share) return res.status(410).json({ error: 'This location link has expired or sharing has stopped.' });
  res.json({ latitude: share.lat, longitude: share.lng, updatedAt: new Date(share.updatedAt).toISOString(), expiresAt: new Date(share.expiresAt).toISOString() });
});

app.delete('/api/location-shares/:token', (req, res) => {
  liveLocationShares.delete(req.params.token);
  res.sendStatus(204);
});

app.get('/share/:token', (req, res) => {
  if (!getActiveShare(req.params.token)) {
    return res.status(410).send('This live-location link has expired or sharing has stopped.');
  }
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// Submit Report & Process AI Pipeline
app.post('/api/reports', (req, res) => {
  const { reporterType, description, locationLabel, latitude, longitude, time } = req.body;
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);

  if (!description || !locationLabel || !Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)) {
    return res.status(400).json({ error: 'Missing required report fields.' });
  }

  // AI Analysis Step
  const aiAnalysis = analyzeReportText(description);

  const reportRecord = {
    id: 'SAF-' + Date.now().toString().slice(-5),
    reporterType: reporterType || 'General', // women, child, student, etc.
    description,
    locationLabel,
    location: {
      lat: parsedLatitude,
      lng: parsedLongitude
    },
    time: time || new Date().toISOString(),
    aiAnalysis,
    timestamp: new Date()
  };

  reports.push(reportRecord);

  res.status(201).json({
    message: 'Report filed anonymously.',
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
  let recommendedActions = ['Continue monitoring anonymous submissions.'];

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
    reports: reports
  });
});

app.listen(PORT, () => {
  console.log(`SAFIRA Server running on http://localhost:${PORT}`);
});