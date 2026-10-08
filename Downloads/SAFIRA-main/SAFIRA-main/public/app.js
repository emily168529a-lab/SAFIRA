let map;
let incidentMap;
let zoneLayers = [];
let reportMarkers = [];
let userPinMarker = null;
let selectedLocationLabel = '';

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadSafetyData();
  setupNavigation();

  // Submit Incident Report
  document.getElementById('reportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const latitude = document.getElementById('latitude').value;
    const longitude = document.getElementById('longitude').value;
    const status = document.getElementById('pinnedCoordsStatus');
    if (latitude === '' || longitude === '') {
      if (status) status.textContent = 'Choose your incident location using GPS or the map before submitting.';
      return;
    }

    const payload = {
      reporterType: document.getElementById('reporterType').value,
      description: document.getElementById('description').value,
      locationLabel: document.getElementById('locationInput').value,
      latitude,
      longitude,
      time: document.getElementById('reportTime').value || new Date().toISOString()
    };

    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to submit this report.');
      displayAIOutput(data.aiOutput);
      loadSafetyData();
      document.getElementById('reportForm').reset();
      if (userPinMarker) incidentMap.removeLayer(userPinMarker);
      userPinMarker = null;
      selectedLocationLabel = '';
      if (status) status.textContent = 'Choose your incident location on the map or use your current location.';
    } catch (err) {
      console.error('Error filing report:', err);
      if (status) status.textContent = err.message;
    }
  });

});

function setupNavigation() {
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#"]');
    if (link) {
      const targetId = link.getAttribute('href').slice(1);
      if (document.getElementById(targetId)) {
      e.preventDefault();
      showPage(targetId);
      }
    }
  });

  showPage(document.getElementById(location.hash.slice(1)) ? location.hash.slice(1) : 'home');
}

function showPage(pageId) {
  const sections = document.querySelectorAll('section');

  sections.forEach(sec => {
    if (sec.id === pageId || (pageId === 'home' && sec.dataset.page === 'home')) {
      sec.style.display = 'block';
    } else {
      sec.style.display = 'none';
    }
  });

  if (location.hash !== `#${pageId}`) history.replaceState(null, '', `#${pageId}`);
  document.querySelectorAll('.nav-links a').forEach(link => {
    link.classList.toggle('active', link.getAttribute('href') === `#${pageId}`);
  });

  if (pageId === 'dashboard' && map) {
    setTimeout(() => {
      map.invalidateSize();
    }, 200);
  }
  if (pageId === 'report' && incidentMap) {
    setTimeout(() => incidentMap.invalidateSize(), 200);
  }
}

function initMap() {
  map = L.map('map').setView([12.9849, 77.7289], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  incidentMap = L.map('incidentMap').setView([12.9849, 77.7289], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(incidentMap);

  incidentMap.on('click', (e) => {
    updateSelectedLocation(e.latlng.lat, e.latlng.lng, 'Pinned map location');
  });

  map.on('click', (e) => {
    const status = document.getElementById('pinnedCoordsStatus');
    if (status) status.textContent = 'Choose a report location on the map in the incident form.';
  });
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
    (data.zones || []).forEach(zone => {
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
    (data.reports || []).forEach(report => {
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
        <strong>Area:</strong> ${report.locationLabel || 'Not specified'}<br>
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
    actionText: 'Report Harassment Anonymously',
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

/* --- PRE-FILL EXECUTION HANDLER --- */
function prefillAndScroll(type, desc) {
  // 1. Close and hide modal
  const modal = document.getElementById('infoModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }

  // 2. Pre-fill reporter category dropdown
  const reporterSelect = document.getElementById('reporterType');
  if (reporterSelect) {
    reporterSelect.value = type;
  }

  // 3. Pre-fill incident description
  const descTextarea = document.getElementById('description');
  if (descTextarea) {
    descTextarea.value = desc;
  }

  // 4. Pre-fill current time if empty
  const reportTimeInput = document.getElementById('reportTime');
  if (reportTimeInput && !reportTimeInput.value) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    reportTimeInput.value = now.toISOString().slice(0, 16);
  }

  // 5. Scroll directly to the report form section
  const reportSection = document.getElementById('report') || document.getElementById('reportForm');
  if (reportSection) {
    const yOffset = -70; // Clearance for fixed navbar
    const y = reportSection.getBoundingClientRect().top + window.pageYOffset + yOffset;
    window.scrollTo({ top: y, behavior: 'smooth' });
  }

  // 6. Focus textarea and position cursor
  setTimeout(() => {
    if (descTextarea) {
      descTextarea.focus();
      descTextarea.setSelectionRange(descTextarea.value.length, descTextarea.value.length);
    }
  }, 400);
}
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

  itemsHtml += `<button class="modal-action-btn" onclick="prefillAndScroll('${data.actionType}', '${data.actionDesc}')">${data.actionText}</button>`;

  body.innerHTML = itemsHtml;
  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('infoModal').classList.add('hidden');
}

function closeModalOnBackdrop(e) {
  if (e.target.id === 'infoModal') {
    closeModal();
  }
}

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
    actionText: 'Report Harassment Anonymously',
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
  itemsHtml += `<button type="button" class="modal-action-btn" onclick="prefillAndScroll('${data.actionType}', '${data.actionDesc.replace(/'/g, "\\'")}')">${data.actionText}</button>`;

  body.innerHTML = itemsHtml;
  modal.classList.remove('hidden');
}

function closeModal() {
  const modal = document.getElementById('infoModal');
  if (modal) modal.classList.add('hidden');
}

function closeModalOnBackdrop(e) {
  if (e.target.id === 'infoModal') {
    closeModal();
  }
}

// Master prefill function with explicit scrolling and visual confirmation
function prefillAndScroll(type, desc) {
  // 1. Close the modal
  closeModal();

  // 2. Select form fields
  const reporterSelect = document.getElementById('reporterType');
  const descTextarea = document.getElementById('description');
  const reportTimeInput = document.getElementById('reportTime');
  const formElement = document.getElementById('reportForm');
  const reportSection = document.getElementById('report');

  // 3. Fill values
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

  // 4. Scroll smoothly right to the form
  if (reportSection) {
    showPage('report');
    reportSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // 5. Apply highlight animation to give the user visual feedback
  if (formElement) {
    formElement.classList.remove('form-highlight-pulse');
    void formElement.offsetWidth; // Force CSS reflow
    formElement.classList.add('form-highlight-pulse');
  }

  // 6. Focus the description textarea so the user can continue typing
  setTimeout(() => {
    if (descTextarea) {
      descTextarea.focus();
      // Move cursor to the end of pre-filled text
      descTextarea.setSelectionRange(descTextarea.value.length, descTextarea.value.length);
    }
  }, 450);
}
/* =========================================================
   CLICK-ONLY NAV LINK ACTIVE STATE
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
  const navLinks = document.querySelectorAll('.nav-links a');

  navLinks.forEach(link => {
    link.addEventListener('click', function (e) {
      // Remove 'active' class from all links
      navLinks.forEach(l => l.classList.remove('active'));

      // Add 'active' class only to the clicked link
      this.classList.add('active');
    });
  });
});

/* =========================================================
   INCIDENT LOCATION PICKER
   ========================================================= */
document.getElementById('pinOnMapBtn')?.addEventListener('click', () => {
  document.getElementById('incidentMap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const status = document.getElementById('pinnedCoordsStatus');
  if (status) status.textContent = 'Click the map or drag the pin to choose the incident location.';
  setTimeout(() => incidentMap.invalidateSize(), 250);
});

document.getElementById('locateMeBtn')?.addEventListener('click', () => {
  const status = document.getElementById('pinnedCoordsStatus');
  if (!navigator.geolocation) {
    if (status) status.textContent = 'Location is not supported by this browser. Choose a point on the map instead.';
    return;
  }
  if (status) status.textContent = 'Detecting current GPS location...';

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      updateSelectedLocation(lat, lng, 'Current location (GPS)');
      incidentMap.setView([lat, lng], 16);
    },
    () => {
      if (status) status.textContent = 'Unable to get your location. Check browser permission or choose a point on the map.';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

function updateSelectedLocation(lat, lng, label) {
  const latInput = document.getElementById('latitude');
  const lngInput = document.getElementById('longitude');
  const locInput = document.getElementById('locationInput');
  const status = document.getElementById('pinnedCoordsStatus');

  if (latInput) latInput.value = lat.toFixed(6);
  if (lngInput) lngInput.value = lng.toFixed(6);
  if (locInput && (!locInput.value || locInput.value === selectedLocationLabel)) {
    locInput.value = label;
  }
  selectedLocationLabel = locInput ? locInput.value : label;
  if (status) {
    status.textContent = `Location selected: ${selectedLocationLabel}`;
  }

  if (incidentMap && typeof L !== 'undefined') {
    if (userPinMarker) {
      userPinMarker.setLatLng([lat, lng]);
    } else {
      userPinMarker = L.marker([lat, lng], { draggable: true }).addTo(incidentMap);
      userPinMarker.on('dragend', function(event) {
        const pos = event.target.getLatLng();
        updateSelectedLocation(pos.lat, pos.lng, 'Pinned map location');
      });
    }
  }
}
