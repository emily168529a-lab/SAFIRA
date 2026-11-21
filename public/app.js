let map;
let zoneLayers = [];
let reportMarkers = [];
let policeRadiusCircle = null;
const POLICE_RADIUS_METERS = 5000;
let policeDirectory = null;
let policeStationMarkers = [];
let currentUserLocation = null;
let currentLocationMarker = null;
let reportLocationMarker = null;
let reportVerificationChallengeId = null;
let reportVerificationPhone = null;
let reportVerificationVerified = false;
let activeLocationShareToken = null;
let activeLocationShareExpiresAt = null;
let activeLocationShareWatchId = null;
let activeLocationShareTimer = null;
let activeLocationShareStatus = null;
let lastLocationShareUpdateAt = 0;

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadSafetyData();
  loadPoliceStations();
  setupNavigation();
  setupReportLocationWarning();
  setupReportVerification();

  // Submit Incident Report
  document.getElementById('reportForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const payload = getReportPayload();
    if (!isValidLocation(payload.latitude, payload.longitude)) {
      document.getElementById('reportSubmitStatus').textContent = 'Enter valid latitude and longitude coordinates.';
      return;
    }

    const reportLocation = { latitude: Number(payload.latitude), longitude: Number(payload.longitude) };
    updateSelectedLocation(reportLocation.latitude, reportLocation.longitude, 'Report location');
    const outsideGpsRadius = !currentUserLocation ||
      getDistanceMeters(currentUserLocation, reportLocation) > POLICE_RADIUS_METERS;
    const outsideDirectory = Boolean(policeDirectory && !isWithinDirectoryCoverage(reportLocation));

    if (outsideGpsRadius || outsideDirectory || !policeDirectory) {
      showReportLocationWarning(payload, outsideGpsRadius, outsideDirectory);
      return;
    }

    await submitReport(payload);
  });

  // Submit Zone Overlay
  const zoneForm = document.getElementById('zoneForm');
  if (zoneForm) zoneForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const newZone = {
      name: document.getElementById('zoneName').value,
      type: document.getElementById('zoneType').value,
      lat: document.getElementById('zoneLat').value,
      lng: document.getElementById('zoneLng').value,
      radius: document.getElementById('zoneRadius').value,
      description: 'Community mapped area near school/workplace.'
    };

    try {
      const res = await fetch('/api/zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newZone)
      });
      if (res.ok) {
        loadSafetyData();
        document.getElementById('zoneForm').reset();
      }
    } catch (err) {
      console.error('Error adding zone:', err);
    }
  });
});

function setupNavigation() {
  const sectionLinks = document.querySelectorAll('a[href^="#"]');

  sectionLinks.forEach(link => {
    const targetId = link.getAttribute('href').slice(1);
    const target = document.getElementById(targetId);
    if (!target || target.tagName !== 'SECTION') return;

    link.addEventListener('click', (e) => {
      e.preventDefault();
      showPage(targetId, true);
    });
  });

  window.addEventListener('hashchange', () => {
    const pageId = window.location.hash.slice(1);
    const target = document.getElementById(pageId);
    showPage(target && target.tagName === 'SECTION' ? pageId : 'home');
  });

  const initialPageId = window.location.hash.slice(1);
  const initialTarget = document.getElementById(initialPageId);
  showPage(initialTarget && initialTarget.tagName === 'SECTION' ? initialPageId : 'home');
}

function showPage(pageId, updateHistory = false) {
  if (updateHistory && window.location.hash !== `#${pageId}`) {
    window.history.pushState(null, '', `#${pageId}`);
  }

  const sections = document.querySelectorAll('section');

  sections.forEach(sec => {
    if (sec.id === pageId) {
      sec.style.display = 'block';
    } else {
      sec.style.display = 'none';
    }
  });

  const homeBanner = document.querySelector('.banner-section');
  if (homeBanner) homeBanner.style.display = pageId === 'home' ? 'block' : 'none';

  document.querySelectorAll('.nav-links a').forEach(link => {
    link.classList.toggle('active', link.hash === `#${pageId}`);
  });

  if (pageId === 'report' || pageId === 'dashboard') {
    requestCurrentLocation();
  }

  // Fix Leaflet map sizing issue on tab switch
  if (pageId === 'dashboard' && map) {
    setTimeout(() => {
      map.invalidateSize();
    }, 200);
  }
}

function initMap() {
  map = L.map('map').setView([12.9849, 77.7289], 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  map.on('click', (e) => {
    const zoneLat = document.getElementById('zoneLat');
    const zoneLng = document.getElementById('zoneLng');
    if (zoneLat) zoneLat.value = e.latlng.lat.toFixed(5);
    if (zoneLng) zoneLng.value = e.latlng.lng.toFixed(5);
    updateSelectedLocation(e.latlng.lat, e.latlng.lng, 'Pinned map location');
  });
}

async function loadPoliceStations() {
  const status = document.getElementById('nearbyStationsStatus');
  if (status) status.textContent = 'Loading the locally stored Bengaluru station directory...';

  try {
    const response = await fetch('/data/bengaluru-police-stations.json');
    if (!response.ok) throw new Error('Unable to load the local station directory.');

    const directory = await response.json();
    const stationsAreValid = directory && Array.isArray(directory.stations) &&
      directory.stations.length > 0 &&
      directory.stations.every(station =>
        typeof station.name === 'string' &&
        Number.isFinite(station.latitude) &&
        Number.isFinite(station.longitude));
    if (!stationsAreValid || !directory.coverage) {
      throw new Error('The local station directory has an invalid format.');
    }

    policeDirectory = directory;
    if (currentUserLocation) {
      renderNearbyStations();
    } else if (status) {
      status.textContent = 'Allow GPS to see mapped stations within 5 km.';
    }
  } catch (error) {
    if (status) status.textContent = 'Nearby stations are unavailable because the local station directory could not be loaded.';
    console.error('Error loading police station directory:', error);
  }
}

function isValidLocation(latitude, longitude) {
  if (latitude === '' || longitude === '') return false;
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

function getDistanceMeters(first, second) {
  const earthRadiusMeters = 6371000;
  const toRadians = Math.PI / 180;
  const latitudeDifference = (second.latitude - first.latitude) * toRadians;
  const longitudeDifference = (second.longitude - first.longitude) * toRadians;
  const firstLatitude = first.latitude * toRadians;
  const secondLatitude = second.latitude * toRadians;
  const haversine = Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) *
    Math.sin(longitudeDifference / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function isWithinDirectoryCoverage(location) {
  if (!policeDirectory) return false;
  const { coverage } = policeDirectory;
  return location.latitude >= coverage.minLatitude &&
    location.latitude <= coverage.maxLatitude &&
    location.longitude >= coverage.minLongitude &&
    location.longitude <= coverage.maxLongitude;
}

function getStationsByDistance(location) {
  if (!policeDirectory) return [];
  return policeDirectory.stations
    .map(station => ({
      ...station,
      distanceMeters: getDistanceMeters(location, {
        latitude: station.latitude,
        longitude: station.longitude
      })
    }))
    .sort((first, second) => first.distanceMeters - second.distanceMeters);
}

function formatStationDistance(distanceMeters) {
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)} m`;
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

function makeStationListItem(station) {
  const item = document.createElement('li');
  item.className = 'station-list-item';

  const name = document.createElement('span');
  name.className = 'station-name';
  name.textContent = station.name;

  const distance = document.createElement('span');
  distance.className = 'station-distance';
  distance.textContent = formatStationDistance(station.distanceMeters);

  const details = document.createElement('span');
  details.className = 'station-details';
  details.appendChild(distance);

  if (typeof station.phone === 'string') {
    const phone = station.phone.replace(/[^\d+]/g, '');
    if (/^\+?\d{7,15}$/.test(phone)) {
      const callLink = document.createElement('a');
      callLink.className = 'station-phone';
      callLink.href = `tel:${phone}`;
      callLink.textContent = `Call ${station.phone}`;
      details.appendChild(callLink);
    }
  }

  item.append(name, details);
  return item;
}

function renderNearbyStations() {
  const status = document.getElementById('nearbyStationsStatus');
  const list = document.getElementById('nearbyStationsList');
  if (!status || !list || !map) return;

  policeStationMarkers.forEach(marker => map.removeLayer(marker));
  policeStationMarkers = [];
  list.replaceChildren();

  if (!policeDirectory) {
    status.textContent = 'The local station directory is unavailable.';
    return;
  }

  if (!currentUserLocation) {
    status.textContent = 'Allow GPS to see mapped stations within 5 km.';
    return;
  }

  if (!isWithinDirectoryCoverage(currentUserLocation)) {
    status.textContent = 'The locally stored station directory covers Bengaluru and nearby areas only; this GPS location is outside its coverage.';
    return;
  }

  const stations = getStationsByDistance(currentUserLocation)
    .filter(station => station.distanceMeters <= POLICE_RADIUS_METERS);

  if (stations.length === 0) {
    status.textContent = 'No mapped police stations were found within 5 km of your GPS location.';
    return;
  }

  status.textContent = `${stations.length} mapped station${stations.length === 1 ? '' : 's'} within 5 km, sorted by straight-line distance from your GPS location.`;

  stations.forEach(station => {
    list.appendChild(makeStationListItem(station));
    const marker = L.circleMarker([station.latitude, station.longitude], {
      color: '#1d4ed8',
      fillColor: '#2563eb',
      fillOpacity: 1,
      radius: 7,
      weight: 2
    }).addTo(map);

    const popup = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = station.name;
    const distance = document.createElement('div');
    distance.textContent = `${formatStationDistance(station.distanceMeters)} straight-line distance from your current GPS location`;
    popup.append(name, distance);
    marker.bindPopup(popup);
    policeStationMarkers.push(marker);
  });
}

function getReportPayload() {
  return {
    reporterType: document.getElementById('reporterType').value,
    description: document.getElementById('description').value,
    latitude: document.getElementById('latitude').value,
    longitude: document.getElementById('longitude').value,
    time: document.getElementById('reportTime').value || new Date().toISOString()
  };
}

function setupReportLocationWarning() {
  const continueButton = document.getElementById('continueReportSubmit');
  const useCurrentLocationButton = document.getElementById('useCurrentLocationForReport');

  ['latitude', 'longitude'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      if (!document.getElementById('reportStationWarning').classList.contains('hidden')) {
        hideReportLocationWarning();
      }
    });
  });

  continueButton.addEventListener('click', async () => {
    const payload = getReportPayload();
    if (!isValidLocation(payload.latitude, payload.longitude)) {
      document.getElementById('reportSubmitStatus').textContent = 'Enter valid latitude and longitude coordinates.';
      return;
    }
    hideReportLocationWarning();
    await submitReport(payload);
  });

  useCurrentLocationButton.addEventListener('click', () => {
    if (!currentUserLocation) return;
    updateSelectedLocation(currentUserLocation.latitude, currentUserLocation.longitude, 'Current GPS location');
    document.getElementById('reportSubmitStatus').textContent = '';
    hideReportLocationWarning();
  });
}

function setupReportVerification() {
  const phoneInput = document.getElementById('reportPhoneInput');
  phoneInput.addEventListener('input', () => {
    if (reportVerificationPhone && phoneInput.value.trim() !== reportVerificationPhone) {
      resetReportOtpVerification('Phone number changed. Send a new OTP to verify it.');
    }
  });
  document.getElementById('sendReportOtpButton').addEventListener('click', sendReportOtp);
  document.getElementById('verifyReportOtpButton').addEventListener('click', verifyReportOtp);
  resetReportOtpVerification();
}

function resetReportOtpVerification(message) {
  reportVerificationChallengeId = null;
  reportVerificationPhone = null;
  reportVerificationVerified = false;
  document.getElementById('reportOtpFields').classList.add('hidden');
  document.getElementById('reportOtpInput').value = '';
  document.getElementById('reportOtpInput').disabled = false;
  document.getElementById('submitReportButton').disabled = true;
  document.getElementById('sendReportOtpButton').disabled = false;
  document.getElementById('sendReportOtpButton').textContent = 'Send OTP';
  document.getElementById('reportVerificationStatus').textContent =
    message || 'Verify your phone to enable report submission.';
}

async function sendReportOtp() {
  const phoneInput = document.getElementById('reportPhoneInput');
  const sendButton = document.getElementById('sendReportOtpButton');
  const status = document.getElementById('reportVerificationStatus');
  if (!phoneInput.reportValidity()) return;

  const phone = phoneInput.value.trim();
  sendButton.disabled = true;
  status.textContent = 'Sending OTP...';

  try {
    const response = await fetch('/api/report-otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to send an OTP.');
    if (phoneInput.value.trim() !== phone) {
      resetReportOtpVerification('Phone number changed while sending. Send a new OTP to verify it.');
      return;
    }

    reportVerificationChallengeId = data.challengeId;
    reportVerificationPhone = phone;
    reportVerificationVerified = false;
    document.getElementById('reportOtpInput').value = '';
    document.getElementById('reportOtpInput').disabled = false;
    document.getElementById('reportOtpFields').classList.remove('hidden');
    sendButton.textContent = 'Resend OTP';
    status.textContent = 'Development OTP generated. Check the server logs. It expires in five minutes.';
  } catch (error) {
    status.textContent = error.message;
    console.error('Error sending report OTP:', error);
  } finally {
    sendButton.disabled = false;
  }
}

async function verifyReportOtp() {
  const otpInput = document.getElementById('reportOtpInput');
  const verifyButton = document.getElementById('verifyReportOtpButton');
  const status = document.getElementById('reportVerificationStatus');
  const otp = otpInput.value.trim();
  if (!reportVerificationChallengeId) {
    status.textContent = 'Send an OTP first.';
    return;
  }
  if (!/^\d{6}$/.test(otp)) {
    status.textContent = 'Enter the six-digit OTP sent to your phone.';
    otpInput.focus();
    return;
  }

  verifyButton.disabled = true;
  status.textContent = 'Verifying OTP...';
  try {
    const response = await fetch('/api/report-otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: reportVerificationChallengeId, otp })
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 410) resetReportOtpVerification(data.error);
      throw new Error(data.error || 'Unable to verify the OTP.');
    }

    reportVerificationVerified = true;
    otpInput.disabled = true;
    document.getElementById('submitReportButton').disabled = false;
    document.getElementById('sendReportOtpButton').disabled = true;
    status.textContent = 'Phone verified. Your number will not be attached to the report.';
  } catch (error) {
    status.textContent = error.message;
    console.error('Error verifying report OTP:', error);
  } finally {
    verifyButton.disabled = false;
  }
}

function showReportLocationWarning(payload, outsideGpsRadius, outsideDirectory) {
  const warning = document.getElementById('reportStationWarning');
  const message = document.getElementById('reportStationWarningMessage');
  const suggestionStatus = document.getElementById('reportStationSuggestionStatus');
  const suggestions = document.getElementById('reportStationSuggestions');
  const useCurrentLocationButton = document.getElementById('useCurrentLocationForReport');
  const reportLocation = { latitude: Number(payload.latitude), longitude: Number(payload.longitude) };
  const messages = [];

  if (!currentUserLocation) {
    messages.push('Your current GPS location could not be verified, so SAFIRA cannot check whether this report point is within 5 km of you.');
  } else if (outsideGpsRadius) {
    const distance = getDistanceMeters(currentUserLocation, reportLocation);
    messages.push(`This report point is ${formatStationDistance(distance)} from your current GPS location, outside the 5 km range.`);
  }

  if (!policeDirectory) {
    messages.push('The local station directory could not be loaded, so nearby stations cannot be checked.');
  } else if (outsideDirectory) {
    messages.push('This point is outside the coverage of the locally stored Bengaluru station directory.');
  }

  message.textContent = `${messages.join(' ')} Review the mapped stations near the report point before continuing. Proximity is not an official jurisdiction check.`;
  suggestions.replaceChildren();
  useCurrentLocationButton.classList.toggle('hidden', !currentUserLocation);

  if (outsideDirectory || !policeDirectory) {
    suggestionStatus.textContent = 'No local station suggestions are available for this report area.';
  } else {
    const nearestStations = getStationsByDistance(reportLocation);
    const withinRadius = nearestStations.filter(station => station.distanceMeters <= POLICE_RADIUS_METERS);
    const suggestionsToShow = withinRadius.length > 0 ? withinRadius : nearestStations.slice(0, 3);

    if (withinRadius.length === 0) {
      suggestionStatus.textContent = 'No mapped stations are within 5 km of this report point; showing the closest mapped stations instead.';
    } else {
      suggestionStatus.textContent = 'Mapped stations within 5 km of the report point by straight-line distance, nearest first:';
    }
    suggestionsToShow.forEach(station => suggestions.appendChild(makeStationListItem(station)));
  }

  warning.classList.remove('hidden');
  warning.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideReportLocationWarning() {
  document.getElementById('reportStationWarning').classList.add('hidden');
}

async function submitReport(payload) {
  const status = document.getElementById('reportSubmitStatus');
  const verificationStatus = document.getElementById('reportVerificationStatus');
  if (!reportVerificationChallengeId || !reportVerificationVerified ||
      document.getElementById('reportPhoneInput').value.trim() !== reportVerificationPhone) {
    verificationStatus.textContent = 'Send an OTP and verify your phone before submitting the report.';
    document.getElementById('reportPhoneInput').focus();
    return;
  }

  status.textContent = 'Submitting report...';

  try {
    const response = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        verificationChallengeId: reportVerificationChallengeId
      })
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 410) resetReportOtpVerification(data.error);
      throw new Error(data.error || 'Unable to submit the report.');
    }

    displayAIOutput(data.aiOutput);
    await loadSafetyData();
    document.getElementById('reportForm').reset();
    resetReportOtpVerification();
    hideReportLocationWarning();
    status.textContent = data.message || 'Report submitted.';
  } catch (error) {
    status.textContent = `Report submission failed: ${error.message}`;
    console.error('Error filing report:', error);
  }
}

function displayAIOutput(aiOutput) {
  const card = document.getElementById('aiOutputCard');
  const cat = document.getElementById('outCategory');
  const sec = document.getElementById('outSecurity');
  const rec = document.getElementById('outRec');

  cat.innerText = aiOutput.aiAnalysis.category;
  sec.innerText = aiOutput.aiAnalysis.securityLevel;
  rec.innerText = aiOutput.aiAnalysis.recommendation;

  const level = aiOutput.aiAnalysis.securityLevel;
  if (level === 'High Concern') sec.style.backgroundColor = '#ef4444';
  else if (level === 'Moderate Concern') sec.style.backgroundColor = '#f59e0b';
  else sec.style.backgroundColor = '#10b981';

  card.classList.remove('hidden');
}

async function loadSafetyData() {
  try {
    const res = await fetch('/api/dashboard');
    const data = await res.json();

    document.getElementById('totalReportsCount').innerText = data.totalReports;

    const insightsList = document.getElementById('aiInsightsList');
    insightsList.innerHTML = data.aiGeneratedInsights.map(i => `<li>${i}</li>`).join('');

    const actionsList = document.getElementById('aiActionsList');
    actionsList.innerHTML = data.recommendedActions.map(a => `<li>${a}</li>`).join('');

    clearLayers();

    // 1. Draw Safety/Danger Zones
    data.zones.forEach(zone => {
      let zoneColor = '#10b981';
      if (zone.type === 'Danger Zone') zoneColor = '#ef4444';
      if (zone.type === 'Caution Zone') zoneColor = '#f59e0b';

      const circle = L.circle([zone.lat, zone.lng], {
        color: zoneColor,
        fillColor: zoneColor,
        fillOpacity: 0.25,
        radius: zone.radius
      }).addTo(map);

      circle.bindPopup(`
        <strong>${zone.name}</strong><br>
        <b style="color:${zoneColor}">${zone.type}</b><br>
        <em>Radius: ${zone.radius}m</em><br>
        ${zone.description}
      `);

      zoneLayers.push(circle);
    });

    // 2. Draw Incident Report Markers
    data.reports.forEach(report => {
      const level = report.aiAnalysis.securityLevel;
      let color = 'green';
      if (level === 'High Concern') color = 'red';
      if (level === 'Moderate Concern') color = 'orange';

      const circle = L.circleMarker([report.location.lat, report.location.lng], {
        color: color,
        fillColor: color,
        fillOpacity: 0.8,
        radius: 8
      }).addTo(map);

      circle.bindPopup(`
        <strong>Type:</strong> ${report.reporterType}<br>
        <strong>Category:</strong> ${report.aiAnalysis.category}<br>
        <strong>Risk:</strong> ${level}<br>
        <strong>Details:</strong> ${report.description}
      `);

      reportMarkers.push(circle);
    });

  } catch (err) {
    console.error('Error loading safety data:', err);
  }
}

function clearLayers() {
  zoneLayers.forEach(l => map.removeLayer(l));
  reportMarkers.forEach(m => map.removeLayer(m));
  zoneLayers = [];
  reportMarkers = [];
}
/* =========================================================
   MODAL DATA & HANDLERS FOR WOMEN & CHILDREN SECTIONS
   ========================================================= */
const modalContentMap = {
  // WOMEN SECTION
  'workplace': {
    title: '🏢 Workplace Safety Support',
    items: [
      { heading: 'POSH & Legal Rights', text: 'Summary of internal complaints committee (ICC) mandates and evidence retention protocols.' },
      { heading: 'Late-Shift Escort Check', text: 'Night-shift checklist: driver license check, guard escort log, and drop confirmation.' },
      { heading: 'Confidential Whistleblower', text: 'File a sealed report on workplace intimidation or harassment without revealing identity.' },
      { heading: 'Dark Campus & Basement Hazard', text: 'Flag unmonitored basements, isolated elevators, or unlit stairwells.' }
    ],
    actionText: 'Pre-fill Workplace Report',
    actionType: 'Women',
    actionDesc: 'Workplace safety incident / unlit office premises'
  },
  'transport': {
    title: '🚌 Public & Transit Safety',
    items: [
      { heading: 'Live Route Verification', text: 'Cross-reference reported erratic driving zones and unverified transit stops.' },
      { heading: 'Railway & Transit Helplines', text: 'Direct links to Railway Protection (139) and municipal public transit desks.' },
      { heading: 'Late-Night Safe Stop Map', text: 'Highlights 24/7 petrol stations, metro kiosks, and well-lit bus shelters along your route.' }
    ],
    actionText: 'Pre-fill Transit Concern',
    actionType: 'Women',
    actionDesc: 'Transit safety issue (cab, bus, or metro station)'
  },
  'public-spaces': {
    title: '🏙️ Public Spaces & Street Safety',
    items: [
      { heading: 'Streetlight & Blind Spot Tagging', text: 'Flag non-operational lights, unmonitored alleys, or broken camera blind spots.' },
      { heading: 'Safe Haven Locator', text: 'Nearest verified 24/7 pharmacies, commercial stores, and police assistance posts.' },
      { heading: 'Crowd-Assisted Routing', text: 'Spatial map displays well-lit routes prioritized over secluded shortcuts.' }
    ],
    actionText: 'Report Dark Alley / Public Area',
    actionType: 'Women',
    actionDesc: 'Dark street / public spot safety hazard'
  },
  'harassment': {
    title: '⚠️ Harassment & Threat Response',
    items: [
      { heading: 'Timestamped Incident Log', text: 'Store suspect traits, timestamps, vehicle numbers, and notes safely.' },
      { heading: 'Cyber-Stalking Escalation', text: 'Step-by-step guidance to report unauthorized tracking or harassment to cyber units.' },
      { heading: 'Free Legal & Counseling Aid', text: 'Access verified emergency counselor hotlines and pro-bono advisory channels.' }
    ],
    emergencyLinks: [
      { label: 'Women Helpline (1091)', tel: '1091' },
      { label: 'National Emergency (112)', tel: '112' }
    ],
    actionText: 'Report Harassment',
    actionType: 'Women',
    actionDesc: 'Harassment or stalking concern'
  },

  // CHILDREN SECTION
  'simple-reporting': {
    title: '🎈 Simple Options for Reporting',
    items: [
      { heading: 'Tap-to-Report Icons', text: 'Visual buttons for school bullying, feeling unsafe walking home, or strangers.' },
      { heading: 'No Coordinates Needed', text: 'Automatic GPS pick-up without needing manual coordinate inputs.' },
      { heading: 'Voice Message Reporting', text: 'Speak your concern aloud if typing is difficult or intimidating.' }
    ],
    actionText: 'Quick Child Report',
    actionType: 'Child',
    actionDesc: 'School / walking home safety concern'
  },
  'easy-language': {
    title: '🗣️ Easy Language & Help Guide',
    items: [
      { heading: 'Kid-Friendly Terms', text: 'Replaces complicated technical jargon with reassuring, simple language.' },
      { heading: 'Illustrated Safety Tips', text: 'Visual cards showing how to spot safe adults and stay secure outside.' },
      { heading: 'Voice Read-Aloud', text: 'Text-to-speech audio support for all prompts and recommendations.' }
    ],
    actionText: 'Open Guided Report',
    actionType: 'Child',
    actionDesc: 'Safety help request'
  },
  'helpline': {
    title: '📞 Helpline & Emergency Support',
    items: [
      { heading: 'Direct Speed-Dialing', text: 'Direct connection to certified child helpline desks and student protection teams.' },
      { heading: 'Discreet Silent Chat', text: 'Text live with dedicated counselors when speaking out loud is unsafe.' }
    ],
    emergencyLinks: [
      { label: 'Childline (1098)', tel: '1098' },
      { label: 'Police Assistance (112)', tel: '112' }
    ],
    actionText: 'Pre-fill Urgent Incident',
    actionType: 'Child',
    actionDesc: 'Emergency child concern'
  },
  'guardian': {
    title: '🛡️ Guardian & School Guidance',
    items: [
      { heading: 'School Route Analytics', text: 'Review aggregate incident ratings along common school bus and pedestrian paths.' },
      { heading: 'Automated Hotspot Alerts', text: 'Notifies parents when recurrent concerns emerge near registered schools.' },
      { heading: 'Parental Safety Toolkits', text: 'Actionable discussion guides covering digital cyber-safety and physical awareness.' }
    ],
    actionText: 'Guardian Incident Report',
    actionType: 'Child',
    actionDesc: 'Guardian reporting concern near school/campus'
  }
};

/* =========================================================
   MODAL DATA & PRE-FILL HANDLER
   ========================================================= */
const modalContentMap1 = {
  // 1. WORKPLACE
  'workplace': {
    title: '🏢 Workplace Safety Support',
    items: [
      { heading: 'POSH & Legal Rights', text: 'Summary of internal complaints committee (ICC) mandates and evidence retention protocols.' },
      { heading: 'Late-Shift Escort Check', text: 'Night-shift checklist: driver license check, guard escort log, and drop confirmation.' },
      { heading: 'Confidential Whistleblower', text: 'File a sealed report on workplace intimidation or harassment without revealing identity.' },
      { heading: 'Dark Campus & Basement Hazard', text: 'Flag unmonitored basements, isolated elevators, or unlit stairwells.' }
    ],
    actionText: 'Pre-fill Workplace Report',
    actionType: 'Women',
    actionDesc: '[Workplace Concern]: Unsafe office premises / isolated parking basement / non-compliant late-shift transit.'
  },

  // 2. TRANSPORT
  'transport': {
    title: '🚌 Public & Transit Safety',
    items: [
      { heading: 'Live Route Verification', text: 'Cross-reference reported erratic driving zones and unverified transit stops.' },
      { heading: 'Railway & Transit Helplines', text: 'Direct links to Railway Protection (139) and municipal public transit desks.' },
      { heading: 'Late-Night Safe Stop Map', text: 'Highlights 24/7 petrol stations, metro kiosks, and well-lit bus shelters along your route.' }
    ],
    actionText: 'Pre-fill Transit Concern',
    actionType: 'Women',
    actionDesc: '[Transit Concern]: Unsafe commute / suspicious activity at bus stop or cab route / isolated station platform.'
  },

  // 3. PUBLIC SPACES
  'public-spaces': {
    title: '🏙️ Public Spaces & Street Safety',
    items: [
      { heading: 'Streetlight & Blind Spot Tagging', text: 'Flag non-operational lights, unmonitored alleys, or broken camera blind spots.' },
      { heading: 'Safe Haven Locator', text: 'Nearest verified 24/7 pharmacies, commercial stores, and police assistance posts.' },
      { heading: 'Crowd-Assisted Routing', text: 'Spatial map displays well-lit routes prioritized over secluded shortcuts.' }
    ],
    actionText: 'Report Dark Alley / Public Area',
    actionType: 'Women',
    actionDesc: '[Public Area Hazard]: Dark alleyway / non-functioning streetlights / unmonitored public walkway.'
  },

  // 4. HARASSMENT
  'harassment': {
    title: '⚠️ Harassment & Threat Response',
    items: [
      { heading: 'Timestamped Incident Log', text: 'Store suspect traits, timestamps, vehicle numbers, and notes safely.' },
      { heading: 'Cyber-Stalking Escalation', text: 'Step-by-step guidance to report unauthorized tracking or harassment to cyber units.' },
      { heading: 'Free Legal & Counseling Aid', text: 'Access verified emergency counselor hotlines and pro-bono advisory channels.' }
    ],
    emergencyLinks: [
      { label: 'Women Helpline (1091)', tel: '1091' },
      { label: 'National Emergency (112)', tel: '112' }
    ],
    actionText: 'Report Harassment',
    actionType: 'Women',
    actionDesc: '[Harassment / Threat]: Following or stalking behavior / verbal harassment in public area.'
  },

  // CHILDREN SECTION
  'simple-reporting': {
    title: '🎈 Simple Options for Reporting',
    items: [
      { heading: 'Tap-to-Report Icons', text: 'Visual buttons for school bullying, feeling unsafe walking home, or strangers.' },
      { heading: 'No Coordinates Needed', text: 'Automatic GPS pick-up without needing manual coordinate inputs.' },
      { heading: 'Voice Message Reporting', text: 'Speak your concern aloud if typing is difficult or intimidating.' }
    ],
    actionText: 'Quick Child Report',
    actionType: 'Child',
    actionDesc: '[Child Safety]: Unsafe school path / bullying / uncomfortable encounter near campus.'
  },
  'easy-language': {
    title: '🗣️ Easy Language & Help Guide',
    items: [
      { heading: 'Kid-Friendly Terms', text: 'Replaces complicated technical jargon with reassuring, simple language.' },
      { heading: 'Illustrated Safety Tips', text: 'Visual cards showing how to spot safe adults and stay secure outside.' }
    ],
    actionText: 'Open Guided Report',
    actionType: 'Child',
    actionDesc: '[Guided Assistance]: Need help finding a safe zone or contact guardian.'
  },
  'helpline': {
    title: '📞 Helpline & Emergency Support',
    items: [
      { heading: 'Direct Speed-Dialing', text: 'Direct connection to certified child helpline desks and student protection teams.' },
      { heading: 'Discreet Silent Chat', text: 'Text live with dedicated counselors when speaking out loud is unsafe.' }
    ],
    emergencyLinks: [
      { label: 'Childline (1098)', tel: '1098' },
      { label: 'Police Assistance (112)', tel: '112' }
    ],
    actionText: 'Pre-fill Urgent Incident',
    actionType: 'Child',
    actionDesc: '[Urgent Child Issue]: Immediate help needed near campus or transit route.'
  },
  'guardian': {
    title: '🛡️ Guardian & School Guidance',
    items: [
      { heading: 'School Route Analytics', text: 'Review aggregate incident ratings along common school bus and pedestrian paths.' },
      { heading: 'Automated Hotspot Alerts', text: 'Notifies parents when recurrent concerns emerge near registered schools.' }
    ],
    actionText: 'Guardian Incident Report',
    actionType: 'Child',
    actionDesc: '[Guardian Report]: Safety hazard flagged near school perimeter or bus pickup point.'
  }
};

function openModal(key) {
  const data = modalContentMap[key];
  if (!data) return;

  const modal = document.getElementById('infoModal');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');

  title.textContent = data.title;

  let itemsHtml = '<ul class="modal-feature-list">';
  data.items.forEach(item => {
    itemsHtml += `<li><strong>${item.heading}</strong>${item.text}</li>`;
  });
  itemsHtml += '</ul>';

  if (data.emergencyLinks) {
    itemsHtml += '<div class="modal-emergency-grid">';
    data.emergencyLinks.forEach(link => {
      itemsHtml += `<a href="tel:${link.tel}" class="emergency-dial-btn">📞 ${link.label}</a>`;
    });
    itemsHtml += '</div><br>';
  }

  // Pre-fill action button
  itemsHtml += `<a href="#report" class="modal-action-btn" id="modalPrefillButton">${data.actionText}</a>`;

  body.innerHTML = itemsHtml;
  modal.classList.remove('hidden');
  modal.style.display = 'flex';

  const prefillButton = document.getElementById('modalPrefillButton');
  prefillButton.addEventListener('click', () => {
    prefillAndScroll(data.actionType, data.actionDesc);
  });
}

function closeModal() {
  const modal = document.getElementById('infoModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = '';
  }
}

function closeModalOnBackdrop(e) {
  if (e.target.id === 'infoModal') {
    closeModal();
  }
}

// Master prefill function with explicit scrolling and visual confirmation
function prefillAndScroll(type, desc) {
  closeModal();
  showPage('report', true);

  const reporterSelect = document.getElementById('reporterType');
  const descTextarea = document.getElementById('description');
  const reportTimeInput = document.getElementById('reportTime');
  const formElement = document.getElementById('reportForm');
  const reportSection = document.getElementById('report');

  if (reporterSelect) {
    reporterSelect.value = type;
  }

  if (descTextarea) {
    descTextarea.value = desc;
  }

  // Auto-fill current timestamp if empty
  if (reportTimeInput && !reportTimeInput.value) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    reportTimeInput.value = now.toISOString().slice(0, 16);
  }

  if (reportSection) {
    reportSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (formElement) {
    formElement.classList.remove('form-highlight-pulse');
    void formElement.offsetWidth;
    formElement.classList.add('form-highlight-pulse');
  }

  setTimeout(() => {
    if (descTextarea) {
      descTextarea.focus();
      // Move cursor to the end of pre-filled text
      descTextarea.setSelectionRange(descTextarea.value.length, descTextarea.value.length);
    }
  }, 450);
}
/* =========================================================
   MAP CLICK-TO-PIN & GEOLOCATION HANDLERS
   ========================================================= */
// "Pin from Map" button: scrolls smoothly down to the Leaflet map
document.getElementById('pinOnMapBtn')?.addEventListener('click', () => {
  const mapElement = document.getElementById('map');
  const status = document.getElementById('pinnedCoordsStatus');
  if (mapElement) {
    mapElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (status) {
      status.textContent = '👇 Click any point on the map below to drop your pin.';
    }
  }
});

function requestCurrentLocation() {
  const setStatus = (message) => {
    ['locationStatus', 'mapLocationStatus'].forEach(id => {
      const status = document.getElementById(id);
      if (status) status.textContent = message;
    });
  };

  if (window.isSecureContext === false) {
    setStatus('Location access requires HTTPS or localhost.');
    return;
  }

  if (!navigator.geolocation) {
    setStatus('Location is not supported by this browser. Enter coordinates manually.');
    return;
  }

  setStatus('Getting your current location...');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      updateCurrentUserLocation(lat, lng);
      updateSelectedLocation(lat, lng, 'Current GPS Location Detected');
      if (typeof map !== 'undefined') {
        map.setView([lat, lng], 11);
      }
      setStatus(`Location added: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    },
    (error) => {
      if (error.code === 1) {
        setStatus('Location permission denied. Allow location access or enter coordinates manually.');
      } else if (error.code === 3) {
        setStatus('Location request timed out. Try again or enter coordinates manually.');
      } else {
        setStatus('Current location is unavailable. Check location services or enter coordinates manually.');
      }
    },
    { enableHighAccuracy: true, maximumAge: 60000, timeout: 10000 }
  );
}

// "Use My GPS" button: grabs device coordinates
document.getElementById('locateMeBtn')?.addEventListener('click', requestCurrentLocation);
document.getElementById('locateMapBtn')?.addEventListener('click', requestCurrentLocation);

function updateCurrentUserLocation(lat, lng) {
  currentUserLocation = { latitude: lat, longitude: lng };

  if (typeof map !== 'undefined' && typeof L !== 'undefined') {
    if (policeRadiusCircle) {
      policeRadiusCircle.setLatLng([lat, lng]);
    } else {
      policeRadiusCircle = L.circle([lat, lng], {
        radius: POLICE_RADIUS_METERS,
        color: '#567C8D',
        fillColor: '#C8D9E6',
        fillOpacity: 0.12,
        weight: 2
      }).addTo(map);
      policeRadiusCircle.bindPopup('<strong>5 km from your current GPS location</strong>');
    }

    if (currentLocationMarker) {
      currentLocationMarker.setLatLng([lat, lng]);
    } else {
      currentLocationMarker = L.marker([lat, lng]).addTo(map);
      currentLocationMarker.bindPopup('Your current GPS location');
    }

    renderNearbyStations();
  }
}

// Store report coordinates separately from the user's current GPS location.
function updateSelectedLocation(lat, lng, label) {
  const latInput = document.getElementById('latitude');
  const lngInput = document.getElementById('longitude');
  const locInput = document.getElementById('locationInput');
  const statusMessage = `Report location selected: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  if (latInput) latInput.value = lat;
  if (lngInput) lngInput.value = lng;
  const warning = document.getElementById('reportStationWarning');
  if (warning && !warning.classList.contains('hidden')) hideReportLocationWarning();
  if (locInput && (!locInput.value || locInput.value.startsWith('Pinned'))) {
    locInput.value = label;
  }
  ['locationStatus', 'pinnedCoordsStatus'].forEach(id => {
    const status = document.getElementById(id);
    if (status) status.textContent = statusMessage;
  });

  if (typeof map !== 'undefined' && typeof L !== 'undefined') {
    if (reportLocationMarker) {
      reportLocationMarker.setLatLng([lat, lng]);
    } else {
      reportLocationMarker = L.marker([lat, lng], { draggable: true }).addTo(map);
      reportLocationMarker.bindPopup('Selected report location');
      reportLocationMarker.on('dragend', function(event) {
        const position = event.target.getLatLng();
        updateSelectedLocation(position.lat, position.lng, `Pinned: ${position.lat.toFixed(4)}, ${position.lng.toFixed(4)}`);
      });
    }
  }
}
/* =========================================================
   CHILDREN SAFETY ACTIONS (ZERO-FORM & PRIVATE SHARING)
   ========================================================= */

// 1. "I'M BEING FOLLOWED" (Zero Form, Instant Actions)
function openChildFollowedModal() {
  const modal = document.getElementById('childActionModal');
  const content = document.getElementById('childModalContent');
  if (!modal || !content) return;

  content.innerHTML = `
    <span class="urgent-badge">EMERGENCY PROTOCOL</span>
    <h2>🚨 Are you being followed?</h2>
    
    <div class="advice-box">
      🚶 <strong>Stay in a public, crowded place.</strong> Head towards open shops, security desks, or lit main roads.
    </div>

    <div class="child-btn-grid">
      <a href="tel:1098" class="child-btn child-btn-red">📞 Call Guardian / Childline (1098)</a>
      <a href="tel:112" class="child-btn child-btn-red">🚨 Call National Emergency (112)</a>
      <button type="button" class="child-btn child-btn-teal" onclick="openShareLocationModal()">📍 Share My Live Location Privately</button>
    </div>
  `;

  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

// 2. "SHARE MY LOCATION" (Private, Time-Limited, Never on Public Dashboard)
function openShareLocationModal() {
  closeChildActionModal();
  openChildModal('share-location');
}

// Retain the legacy handler name while routing through the live-share flow.
function generatePrivateLocationLink() {
  generateChildShareLink();
}

// 3. "BULLYING / HARASSMENT" MODAL
function openBullyingModal() {
  const modal = document.getElementById('childActionModal');
  const content = document.getElementById('childModalContent');
  if (!modal || !content) return;

  content.innerHTML = `
    <h2>🛑 Bullying & School Harassment</h2>
    <p>Report school bullying, teasing, online threats, or physical harassment safely and confidentially.</p>

    <div class="advice-box" style="background:#eef6fc; border-left-color:#567C8D; color:#2F4156;">
      🛡️ You have the right to be safe at school and online. Reports can be filed confidentially.
    </div>

    <div class="modal-emergency-grid">
      <a href="tel:1098" class="emergency-dial-btn">📞 Childline (1098)</a>
      <a href="tel:112" class="emergency-dial-btn">🚨 Emergency (112)</a>
      <a href="tel:100" class="emergency-dial-btn">👮 Police (100)</a>
    </div>

    <button type="button" class="child-btn child-btn-blue" style="margin-top: 1rem;" onclick="prefillBullyingReport()">
      📝 Pre-fill Bullying Report
    </button>
  `;

  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

// Prefills Bullying details into the form and switches to Report Concern
function prefillBullyingReport() {
  closeChildActionModal();
  prefillAndScroll(
    'Child',
    'School Safety / Harassment Concern: Reporting repetitive bullying, physical/verbal intimidation, or cyber harassment.'
  );
}

// Modal closing helpers
function closeChildActionModal() {
  const modal = document.getElementById('childActionModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

function closeChildActionModalOnBackdrop(e) {
  if (e.target.id === 'childActionModal') {
    closeChildActionModal();
  }
}
/* =========================================================
   CHILDREN SECTION INTERACTIVE CARDS & MODALS
   ========================================================= */

const childrenContentData = {
  // 1. I'M BEING FOLLOWED
  'followed': {
    title: '🚨 I\'m Being Followed - Immediate Safety',
    advice: '🚶 <strong>Stay in a public, crowded place.</strong> Enter a shop, approach a security guard, or head to a well-lit main road. Do not isolate yourself.',
    features: [
      { heading: 'Do Not Panic', text: 'Walk with purpose towards open spaces with other adults around.' },
      { heading: 'Zero-Form Protocol', text: 'No typing or forms required. Tap the red buttons below to call for help immediately.' },
      { heading: 'Live Alert Option', text: 'Share your temporary private pin so trusted contacts can see where you are.' }
    ],
    emergencyLinks: [
      { label: 'Guardian / Childline (1098)', tel: '1098' },
      { label: 'National Emergency (112)', tel: '112' },
      { label: 'Police Assistance (100)', tel: '100' }
    ],
    actionText: '📍 Share My Live Location Now',
    action: () => openChildModal('share-location')
  },

  // 2. SHARE MY LOCATION
  'share-location': {
    title: '📍 Share Live Location Privately',
    advice: '🔒 <strong>Private temporary link:</strong> Your location is kept in server memory until the selected sharing window ends. It is not shown on the public safety dashboard.',
    customHtml: `
      <div class="select-group">
        <label for="childTrustedContact">Send to:</label>
        <select id="childTrustedContact">
          <option value="Parent">Parent</option>
          <option value="Guardian" selected>Guardian</option>
          <option value="Trusted Adult">Trusted Adult</option>
          <option value="Emergency Contact">Emergency Contact</option>
        </select>
      </div>

      <div class="select-group">
        <label for="childTrustedPhone">Recipient phone number:</label>
        <input id="childTrustedPhone" type="tel" autocomplete="tel" pattern="[+]?[0-9 ()-]{7,20}" placeholder="+91 98765 43210" required>
      </div>

      <div class="select-group">
        <label for="childShareTime">Active Window:</label>
        <select id="childShareTime">
          <option value="15">15 Minutes</option>
          <option value="30" selected>30 Minutes</option>
          <option value="60">1 Hour</option>
        </select>
      </div>

      <button type="button" class="child-btn child-btn-teal" onclick="generateChildShareLink()">
        📲 Start Live Sharing
      </button>

      <div id="childShareResult" style="margin-top: 0.75rem;"></div>
    `
  },

  // 3. BULLYING / HARASSMENT
  'bullying': {
    title: '🛑 Bullying & Threat Response',
    advice: '🛡️ You have the right to feel safe at school and online. You do not have to handle bullying alone.',
    features: [
      { heading: 'Physical & Verbal Bullying', text: 'Report threats, physical pushing, intimidation, or exclusion near campus.' },
      { heading: 'Cyberbullying', text: 'Document abusive messages, unauthorized photo sharing, or threatening texts.' },
      { heading: 'Confidentiality', text: 'Your identity can remain protected when filing this report.' }
    ],
    emergencyLinks: [
      { label: 'Childline (1098)', tel: '1098' },
      { label: 'Student Support (112)', tel: '112' }
    ],
    actionText: '📝 Pre-fill Bullying Incident Report',
    action: handleBullyingPrefill
  }
};

function openChildModal(key) {
  const data = childrenContentData[key];
  if (!data) return;

  const modal = document.getElementById('childModal');
  const title = document.getElementById('childModalTitle');
  const body = document.getElementById('childModalBody');

  if (!modal || !title || !body) return;

  title.innerHTML = data.title;

  let html = '';

  if (data.advice) {
    html += `<div class="advice-box">${data.advice}</div>`;
  }

  if (data.features) {
    html += '<ul class="modal-feature-list">';
    data.features.forEach(f => {
      html += `<li><strong>${f.heading}</strong>${f.text}</li>`;
    });
    html += '</ul>';
  }

  if (data.customHtml) {
    html += data.customHtml;
  }

  if (data.emergencyLinks) {
    html += '<div class="modal-emergency-grid">';
    data.emergencyLinks.forEach(link => {
      html += `<a href="tel:${link.tel}" class="emergency-dial-btn">📞 ${link.label}</a>`;
    });
    html += '</div>';
  }

  if (data.actionText && data.action) {
    html += `<button id="childModalActionButton" type="button" class="child-btn child-btn-blue" style="margin-top: 1rem;">${data.actionText}</button>`;
  }

  body.innerHTML = html;
  const actionButton = document.getElementById('childModalActionButton');
  if (actionButton) actionButton.addEventListener('click', data.action);
  modal.classList.remove('hidden');
  modal.style.display = 'flex';

  if (key === 'share-location' && activeLocationShareToken) {
    showActiveLocationShareControls();
  }
}

function closeChildModal() {
  const modal = document.getElementById('childModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

function closeChildModalOnBackdrop(e) {
  if (e.target.id === 'childModal') {
    closeChildModal();
  }
}

function setLiveShareStatus(message) {
  if (activeLocationShareStatus) activeLocationShareStatus.textContent = message;
}

function showActiveLocationShareControls() {
  const resultDiv = document.getElementById('childShareResult');
  if (!resultDiv) return;

  activeLocationShareStatus = document.createElement('p');
  activeLocationShareStatus.setAttribute('role', 'status');
  activeLocationShareStatus.setAttribute('aria-live', 'polite');
  resultDiv.replaceChildren(activeLocationShareStatus);
  setLiveShareStatus(`Live sharing is active until ${new Date(activeLocationShareExpiresAt).toLocaleTimeString()}.`);

  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.className = 'child-btn child-btn-red';
  stopButton.textContent = 'Stop Sharing';
  stopButton.addEventListener('click', () => stopLiveLocationShare());
  resultDiv.appendChild(stopButton);
}

function generateChildShareLink() {
  const resultDiv = document.getElementById('childShareResult');
  const phoneInput = document.getElementById('childTrustedPhone');
  if (!resultDiv || !phoneInput) return;

  const contact = document.getElementById('childTrustedContact').value;
  const durationMinutes = Number(document.getElementById('childShareTime').value);
  const phone = phoneInput.value.replace(/[ ()-]/g, '');
  if (!/^\+?\d{7,15}$/.test(phone)) {
    resultDiv.textContent = 'Enter a valid phone number, including the country code.';
    return;
  }
  if (![15, 30, 60].includes(durationMinutes)) {
    resultDiv.textContent = 'Choose a valid sharing duration.';
    return;
  }
  if (activeLocationShareToken) {
    resultDiv.textContent = 'Stop the current share before starting another one.';
    return;
  }
  if (window.isSecureContext === false) {
    resultDiv.textContent = 'Live location sharing requires HTTPS or localhost.';
    return;
  }
  if (!navigator.geolocation) {
    resultDiv.textContent = 'Geolocation is not supported by this browser.';
    return;
  }

  resultDiv.textContent = 'Getting your location...';
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      resultDiv.textContent = 'Starting your private live share...';
      try {
        const response = await fetch('/api/location-shares', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            durationMinutes
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to start live location sharing.');

        activeLocationShareToken = data.token;
        activeLocationShareExpiresAt = data.expiresAt;
        activeLocationShareStatus = document.createElement('p');
        activeLocationShareStatus.setAttribute('role', 'status');
        activeLocationShareStatus.setAttribute('aria-live', 'polite');
        resultDiv.replaceChildren(activeLocationShareStatus);

        const localhost = isLoopbackHostname(window.location.hostname);
        const privateNetworkAddress = isPrivateIpv4Address(window.location.hostname);
        let shareOrigin = window.location.origin;
        let lanLinkAvailable = false;

        if (localhost) {
          try {
            const accessResponse = await fetch('/api/location-share-access', { cache: 'no-store' });
            const accessData = await accessResponse.json();
            if (!accessResponse.ok) throw new Error(accessData.error || 'Unable to find a local network address.');
            if (accessData.localNetworkOrigin) {
              shareOrigin = accessData.localNetworkOrigin;
              lanLinkAvailable = true;
            }
          } catch (error) {
            console.error('Unable to determine local network link:', error);
          }
        }

        const shareUrl = new URL(
          `/share-location.html?token=${encodeURIComponent(data.token)}`,
          shareOrigin
        ).href;
        const expiresAt = new Date(data.expiresAt);
        const message = `SAFIRA live location for ${contact}, available until ${expiresAt.toLocaleTimeString()}: ${shareUrl}`;
        const smsLink = document.createElement('a');
        smsLink.href = `sms:${phone}?body=${encodeURIComponent(message)}`;
        smsLink.className = 'child-btn child-btn-teal';
        smsLink.textContent = 'Open SMS to Send Live Link';

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'child-btn child-btn-blue';
        copyButton.textContent = 'Copy Share Link';
        copyButton.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(shareUrl);
            setLiveShareStatus('Live share link copied. Send it only to someone you trust.');
          } catch (error) {
            setLiveShareStatus(`Unable to copy the share link: ${error.message}`);
          }
        });

        const stopButton = document.createElement('button');
        stopButton.type = 'button';
        stopButton.className = 'child-btn child-btn-red';
        stopButton.textContent = 'Stop Sharing';
        stopButton.addEventListener('click', () => stopLiveLocationShare());
        resultDiv.append(smsLink, copyButton, stopButton);

        setLiveShareStatus(
          localhost
            ? lanLinkAvailable
              ? `Live sharing is active until ${expiresAt.toLocaleTimeString()}. The link uses this device's local network address; your contact must be on the same Wi-Fi/network. For remote contacts, deploy SAFIRA over public HTTPS.`
              : `Live sharing is active until ${expiresAt.toLocaleTimeString()}, but this link uses localhost and only works on this device. The local network address could not be detected; use the app's network address or deploy public HTTPS for your contact.`
            : privateNetworkAddress
              ? `Live sharing is active until ${expiresAt.toLocaleTimeString()}. This private network link works only for devices on the same Wi-Fi/network. Use public HTTPS for remote contacts.`
              : `Live sharing is active until ${expiresAt.toLocaleTimeString()}. Send the link by SMS; your contact must open it to view your location.`
        );

        lastLocationShareUpdateAt = Date.now();
        activeLocationShareWatchId = navigator.geolocation.watchPosition(
          (updatedPosition) => {
            if (Date.now() - lastLocationShareUpdateAt < 10000) return;
            lastLocationShareUpdateAt = Date.now();
            updateLiveLocationOnServer(
              data.token,
              updatedPosition.coords.latitude,
              updatedPosition.coords.longitude
            );
          },
          (error) => {
            setLiveShareStatus(
              `New GPS updates are unavailable: ${getLocationErrorMessage(error)} The share remains active with the last known location until you stop it or it expires.`
            );
          },
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
        );
        activeLocationShareTimer = window.setTimeout(
          () => stopLiveLocationShare('The selected sharing period has ended.'),
          Math.max(0, data.expiresAt - Date.now())
        );
      } catch (error) {
        resultDiv.textContent = `Unable to start live sharing: ${error.message}`;
      }
    },
    (error) => {
      resultDiv.textContent = getLocationErrorMessage(error);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127\./.test(normalized);
}

function isPrivateIpv4Address(hostname) {
  return /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

function getLocationErrorMessage(error) {
  if (error.code === 1) return 'Location permission denied. Allow location access in your browser.';
  if (error.code === 3) return 'Location request timed out. Check GPS and try again.';
  return 'Current location is unavailable. Check your device location services.';
}

async function updateLiveLocationOnServer(token, latitude, longitude) {
  if (activeLocationShareToken !== token) return;

  try {
    const response = await fetch(`/api/location-shares/${encodeURIComponent(token)}/location`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude, longitude })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to update live location.');
    if (activeLocationShareToken !== token) return;
    setLiveShareStatus(`Live location updated at ${new Date(data.updatedAt).toLocaleTimeString()}.`);
  } catch (error) {
    if (activeLocationShareToken === token) {
      setLiveShareStatus(`Location update failed: ${error.message}`);
    }
  }
}

async function stopLiveLocationShare(message) {
  const token = activeLocationShareToken;
  const resultDiv = document.getElementById('childShareResult');
  if (resultDiv && activeLocationShareStatus) {
    resultDiv.replaceChildren(activeLocationShareStatus);
  }

  if (activeLocationShareWatchId !== null) {
    navigator.geolocation.clearWatch(activeLocationShareWatchId);
  }
  if (activeLocationShareTimer !== null) {
    window.clearTimeout(activeLocationShareTimer);
  }
  activeLocationShareToken = null;
  activeLocationShareExpiresAt = null;
  activeLocationShareWatchId = null;
  activeLocationShareTimer = null;

  if (!token) {
    setLiveShareStatus(message || 'No active location share.');
    return;
  }

  try {
    const response = await fetch(`/api/location-shares/${encodeURIComponent(token)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('The server could not stop the share.');
    setLiveShareStatus(message || 'Location sharing stopped.');
  } catch (error) {
    setLiveShareStatus(`Sharing stopped on this device, but server cleanup failed: ${error.message}`);
  }
}

// Bullying Pre-fill Handler
function handleBullyingPrefill() {
  closeChildModal();
  prefillAndScroll(
    'Child',
    'School Safety Concern: Reporting persistent verbal harassment / physical bullying / cyberbullying.'
  );
}