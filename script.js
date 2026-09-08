const globalAudioContext = new AudioContext({ sampleRate: 44100 });
let globalChartObject = null;
let globalWorkoutSpeeds = [];
let globalWorkoutInclines = [];
let globalWorkoutRef = null;
let globalWorkoutStartTime = 0;
let globalWorkoutCurrentSpeed = 0;
let globalWorkoutCurrentIncline = 0;
let globalWakeLock = null;
let globalMaxTime = 0;
let globalChartTickRef = null;
let globalWorkoutElapsedMinutesAtStop = null;

function generateBitsForValue(value) {
  result = [0, 1];
  for (let i = 0; i < 8; i++) {
    result.push((value >> i) & 1);
  }
  return result;
}

function generatePcm(speed, incline) {
  const treadmillSpeed = speed * 10;
  const treadmillIncline = incline * 10;
  const checksum = treadmillSpeed + treadmillIncline;

  const dataBits = [
    ...Array(16).fill(0),
    ...generateBitsForValue(treadmillSpeed),
    ...generateBitsForValue(treadmillIncline),
    ...generateBitsForValue(checksum),
    ...Array(10).fill(0),
    ...generateBitsForValue(treadmillSpeed),
    ...generateBitsForValue(treadmillIncline),
    ...generateBitsForValue(checksum),
    ...Array(16).fill(0),
  ];

  const samples = [];
  for (let i = 0; i < dataBits.length; i++) {
    if (dataBits[i] == 0) {
      samples.push(...Array(88).fill(0));
    } else {
      for (let j = 0; j < 88; j++) {
        samples.push(Math.sin(2 * Math.PI * 2000 * (j / 44100.0)));
      }
    }
  }

  return samples;
}

function log(...args) {
  console.log(formatWorkoutTime(getCurrentWorkoutElapsedMinutes()), '-', ...args);
}

async function acquireWakeLock() {
  try {
    globalWakeLock = await navigator.wakeLock.request('screen');
    log('Wake lock acquired');
    globalWakeLock.addEventListener('release', () => log('Wake lock released'));
  } catch (err) {
    log('Wake lock err', err.message);
  }
}

async function releaseWakeLock() {
  if (globalWakeLock != null) {
    await globalWakeLock.release();
    globalWakeLock = null;
    log('Wake lock released')
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && globalWorkoutRef != null) {
    acquireWakeLock();
  }
});

function renderTreadmillControlAudio(speed, incline) {
  log('Setting treadmill speed to', speed, 'and incline to', incline);
  var newPcmData = generatePcm(Number(speed), Number(incline));

  const buffer = new AudioBuffer({
    numberOfChannels: 1,
    length: globalAudioContext.sampleRate, // 1 sec is enough
    sampleRate: globalAudioContext.sampleRate,
  });
  const chanData = buffer.getChannelData(0);
  for (let i = 0; i < newPcmData.length; i++) {
    chanData[i] = newPcmData[i];
  }
  const source = globalAudioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(globalAudioContext.destination);
  source.start();
}

const hiitWorkoutPresets = {
  beginner: { title: 'Beginner HIIT', workSpeed: 5.0, workIncline: 4, sets: 7, runTime: 30, walkTime: 60 },
  intermediate: { title: 'Intermediate HIIT', workSpeed: 6.0, workIncline: 6, sets: 8, runTime: 60, walkTime: 60 },
  advanced: { title: 'Advanced HIIT', workSpeed: 8.0, workIncline: 8, sets: 10, runTime: 60, walkTime: 60 },
};

const hiitSettingsFieldIds = ['hiitWorkSpeed', 'hiitWorkIncline', 'hiitSets', 'hiitRunTime', 'hiitWalkTime'];
const hiitSettingsCookieName = 'hiitSettings';

function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function saveHIITSettings() {
  const settings = {};
  for (const id of hiitSettingsFieldIds) {
    settings[id] = document.getElementById(id).value;
  }
  setCookie(hiitSettingsCookieName, JSON.stringify(settings), 365);
}

function loadHIITSettings() {
  const raw = getCookie(hiitSettingsCookieName);
  if (raw == null) {
    return false;
  }
  const settings = JSON.parse(raw);
  for (const id of hiitSettingsFieldIds) {
    document.getElementById(id).value = settings[id];
  }
  return true;
}

for (const id of hiitSettingsFieldIds) {
  document.getElementById(id).addEventListener('input', () => {
    saveHIITSettings();
    generateHIITWorkout();
  });
}

function selectHIITWorkout(level) {
  const preset = hiitWorkoutPresets[level];
  document.getElementById('hiitWorkSpeed').value = preset.workSpeed;
  document.getElementById('hiitWorkIncline').value = preset.workIncline;
  document.getElementById('hiitSets').value = preset.sets;
  document.getElementById('hiitRunTime').value = preset.runTime;
  document.getElementById('hiitWalkTime').value = preset.walkTime;
  document.getElementById('hiitSettings').hidden = false;
  saveHIITSettings();
  generateHIITWorkout();
}

function generateHIITWorkout() {
  if (globalWorkoutRef != null) {
    alert('Please stop the current workout before creating another one.');
    return;
  }

  const workSpeed = Number(document.getElementById('hiitWorkSpeed').value);
  const workIncline = Number(document.getElementById('hiitWorkIncline').value);
  const sets = Number(document.getElementById('hiitSets').value);
  const runTimeSeconds = Number(document.getElementById('hiitRunTime').value);
  const walkTimeSeconds = Number(document.getElementById('hiitWalkTime').value);

  const speeds = [];
  const inclines = [];
  // Accumulate in whole seconds so repeated additions stay exact; only
  // convert to minutes (a single division) when producing a chart point.
  let timeSeconds = 0;

  const pushPhase = (durationSeconds, speed, incline) => {
    const timeMinutes = timeSeconds / 60;
    speeds.push({x: timeMinutes, y: speed});
    inclines.push({x: timeMinutes, y: incline});
    timeSeconds += durationSeconds;
  };

  // Warm-up: 4 minutes of walking at a quick pace
  pushPhase(30, 2.0, 1.0);
  pushPhase(30, 2.5, 1.0);
  pushPhase(60, 3.0, 1.0);
  pushPhase(120, 3.5, 1.0);

  for (let i = 0; i < sets; i++) {
    pushPhase(runTimeSeconds, workSpeed, workIncline); // Work
    pushPhase(walkTimeSeconds, 3.0, 1.0); // Rest
  }

  // Cool down: 2 minutes of gradually lower speed
  // We already cooled down for a `walkTimeSeconds` before getting here,
  // making the total cooldown time longer.
  pushPhase(60, 3.0, 1.0);
  pushPhase(30, 2.5, 1.0);
  pushPhase(30, 2.0, 1.0);

  // Mark the end of the workout so the last phase holds until this time
  const finalTimeMinutes = timeSeconds / 60;
  speeds.push({x: finalTimeMinutes, y: speeds[speeds.length - 1].y});
  inclines.push({x: finalTimeMinutes, y: inclines[inclines.length - 1].y});

  globalWorkoutSpeeds = speeds;
  globalWorkoutInclines = inclines;
  globalMaxTime = finalTimeMinutes;
  globalWorkoutElapsedMinutesAtStop = null;
  showWorkoutChart();
}

function formatWorkoutTime(minutes) {
  const totalSeconds = Math.round(minutes * 60);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getCurrentWorkoutElapsedMinutes() {
  if (globalWorkoutRef != null) {
    return (Date.now() - globalWorkoutStartTime) / 1000.0 / 60;
  }
  if (globalWorkoutElapsedMinutesAtStop != null) {
    return globalWorkoutElapsedMinutesAtStop;
  }
  return 0;
}

function updateWorkoutChart() {
  globalChartObject.options.plugins.title.text =
    globalWorkoutSpeeds.length > 0 ? formatWorkoutTime(getCurrentWorkoutElapsedMinutes()) : 'Workout';
  globalChartObject.update('none');
}

function showWorkoutChart() {
  const chartEl = document.getElementById('workoutChart');

  globalChartObject?.destroy();
  globalChartObject = new Chart(chartEl, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Speed',
          data: globalWorkoutSpeeds,
          borderWidth: 3,
          pointRadius: 0,
          stepped: 'before',
        },
        {
          label: 'Incline',
          data: globalWorkoutInclines,
          borderWidth: 1,
          pointRadius: 0,
          stepped: 'before',
          fill: 'origin',
        },
      ]
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: {
          beginAtZero: true,
          type: 'linear',
          max: globalMaxTime,
          title: {
            display: true,
            text: 'Minutes',
          },
        },
        y: {
          beginAtZero: true,
          suggestedMax: 10,
        }
      },
      plugins: {
        title: {
          display: true,
          text: globalWorkoutSpeeds.length > 0 ? formatWorkoutTime(getCurrentWorkoutElapsedMinutes()) : 'Workout',
        },
      },
      animation: {
        duration: 100,
      },
    },
    plugins: [{
      afterDraw: function (chart) {
        const ctx = chart.ctx;
        if (globalWorkoutSpeeds.length < 1) {
          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = 'bold 36px serif';
          ctx.fillText('Please generate a workout', chart.width / 2, chart.height / 2);
          ctx.restore();
        } else if (globalWorkoutRef != null) {
          const currentValue = (Date.now() - globalWorkoutStartTime) / 1000.0 / 60;
          const xPosition = chart.scales.x.getPixelForValue(currentValue);
          ctx.save();
          ctx.strokeStyle = '#00000066';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(xPosition, chart.chartArea.bottom);
          ctx.lineTo(xPosition, chart.chartArea.top);
          ctx.stroke();
          ctx.restore();
        }
      },
    }],
  });
}

function startWorkout() {
  if (globalWorkoutSpeeds.length < 1 || globalWorkoutInclines.length < 1) {
    alert('Please generate a workout before starting one.');
    return;
  }

  if (globalWorkoutRef != null) {
    alert('Please stop the current workout before starting another one.');
    return;
  }

  globalWorkoutStartTime = Date.now();
  globalWorkoutElapsedMinutesAtStop = null;
  globalWorkoutCurrentSpeed = 0;
  globalWorkoutCurrentIncline = 0;
  acquireWakeLock();
  processCurrentWorkout();
  globalWorkoutRef = setInterval(() => processCurrentWorkout(), 1000);
  globalChartTickRef = setInterval(() => updateWorkoutChart(), 1000);
  updateWorkoutChart();
}

function stopWorkout() {
  if (globalWorkoutRef != null) {
    globalWorkoutElapsedMinutesAtStop = (Date.now() - globalWorkoutStartTime) / 1000.0 / 60;
    clearInterval(globalWorkoutRef);
    globalWorkoutRef = null;
  }
  if (globalChartTickRef != null) {
    clearInterval(globalChartTickRef);
    globalChartTickRef = null;
  }
  releaseWakeLock();
  updateWorkoutChart();
  // Send stop command
  renderTreadmillControlAudio(25.2, 25.2);
}

function processCurrentWorkout() {
  updateWorkoutChart();
  const currentMinute = (Date.now() - globalWorkoutStartTime) / 1000.0 / 60;

  if (currentMinute > globalWorkoutSpeeds[globalWorkoutSpeeds.length - 1].x) {
    // We're at the end of the workout
    stopWorkout();
    return;
  }

  let chunkIndex = 0;
  for (let i = 0; i < globalWorkoutSpeeds.length; i++) {
    if (globalWorkoutSpeeds[i].x > currentMinute) {
      break;
    } // else:
    chunkIndex = i;
  }
  const chunkSpeed = globalWorkoutSpeeds[chunkIndex].y;
  const chunkIncline = globalWorkoutInclines[chunkIndex].y;
  if (chunkSpeed !== globalWorkoutCurrentSpeed || chunkIncline !== globalWorkoutCurrentIncline) {
    globalWorkoutCurrentSpeed = chunkSpeed;
    globalWorkoutCurrentIncline = chunkIncline;
    renderTreadmillControlAudio(chunkSpeed, chunkIncline);
  }
}

if (loadHIITSettings()) {
  document.getElementById('hiitSettings').hidden = false;
  generateHIITWorkout();
} else {
  selectHIITWorkout('intermediate');
}
