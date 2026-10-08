const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Database (Data Storage)
const reports = [];

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