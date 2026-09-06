const globalAudioContext = new AudioContext({ sampleRate: 44100 });
let globalChartObject = null;
let globalWorkoutSpeeds = [];
let globalWorkoutInclines = [];
let globalWorkoutRef = null;
let globalWorkoutStartTime = 0;
let globalWorkoutCurrentSpeed = 0;
let globalWorkoutCurrentIncline = 0;
let globalWakeLock = null;

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
  console.log(Date(), '-', ...args);
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

// Seedable PRNG from https://stackoverflow.com/a/47593316/4479
function splitmix32(a) {
  return function() {
    a |= 0;
    a = a + 0x9e3779b9 | 0;
    var t = a ^ a >>> 16;
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ t >>> 15) >>> 0) / 4294967296;
  }
}

function generateWorkout() {
  const totalTime = (Number.isNaN(Number.parseFloat(document.getElementById('confWorkoutTime').value)) ? -1 : Number.parseFloat(document.getElementById('confWorkoutTime').value));
  const maxSpeed = (Number.isNaN(Number.parseFloat(document.getElementById('confWorkoutMaxSpeed').value)) ? -1 : Number.parseFloat(document.getElementById('confWorkoutMaxSpeed').value));
  const maxIncline = (Number.isNaN(Number.parseFloat(document.getElementById('confWorkoutMaxIncline').value)) ? -1 : Number.parseFloat(document.getElementById('confWorkoutMaxIncline').value));
  const aggressive = document.getElementById('confWorkoutAggressiveRamp').checked;
  const hills = document.getElementById('confWorkoutHills').checked;
  const seed = (Number.isNaN(Number.parseInt(document.getElementById('confWorkoutSeed').value)) ? Math.round(Math.random() * 10000) : Number.parseInt(document.getElementById('confWorkoutSeed').value));

  if (globalWorkoutRef != null) {
    alert('Please stop the current workout before creating another one.');
    return;
  }

  if (totalTime <= 0 || maxSpeed <= 0 || maxIncline < 0) {
    alert('ERROR: Time, speed, and incline must all be non-negative numbers.');
    return;
  }

  const totalChunks = Math.floor(totalTime / 1.5);
  const warmupChunks = (totalChunks < 8 ? 2 : 3);
  const cooldownChunks = (totalChunks < 8 ? 2 : 3);
  const mainChunks = totalChunks - warmupChunks - cooldownChunks;

  if (mainChunks < 2) {
    alert('ERROR: the specified time is too short. Please increase it.');
    return;
  }

  globalWorkoutSpeeds = [];
  globalWorkoutInclines = [];
  const rng = splitmix32(seed);
  const rng2 = (minInclusive, maxExclusive) => rng() * (maxExclusive - minInclusive) + minInclusive;
  const rng2Ints = (minInclusive, maxExclusive) => Math.floor(rng2(minInclusive, maxExclusive));
  const rng2Halves = (minInclusive, maxExclusive) => rng2Ints(minInclusive * 2, maxExclusive * 2) / 2;

  // Generate the warmup
  const maxWarmupSpeed = Math.min(3, maxSpeed);
  let currentSpeed = rng2Halves(1, maxWarmupSpeed - (warmupChunks / 2.0) + 0.6);
  let currentIncline = 1.5;
  for (let i = 0; i < warmupChunks; i++) {
    const time = globalWorkoutSpeeds.length * 1.5;
    globalWorkoutSpeeds.push({x: time, y: currentSpeed});
    globalWorkoutInclines.push({x: time, y: currentIncline});
    currentSpeed += 0.5;
  }

  // Generate the main workout
  for (let i = 0; i < mainChunks; i++) {
    const time = globalWorkoutSpeeds.length * 1.5;

    // Determine speed
    currentSpeed = globalWorkoutSpeeds[globalWorkoutSpeeds.length - 1].y;
    const chunkMinSpeed = Math.min(currentSpeed, maxSpeed, 3);
    const chunkMaxSpeed = Math.min(currentSpeed + 2, maxSpeed);
    const wasTrendUp = (globalWorkoutSpeeds[globalWorkoutSpeeds.length - 2].y < currentSpeed);
    const wasTrendDown = (globalWorkoutSpeeds[globalWorkoutSpeeds.length - 2].y > currentSpeed);
    const wasTrendLongNeutral = (globalWorkoutSpeeds.length > 4 && currentSpeed == globalWorkoutSpeeds[globalWorkoutSpeeds.length - 2].y && currentSpeed == globalWorkoutSpeeds[globalWorkoutSpeeds.length - 3].y && currentSpeed == globalWorkoutSpeeds[globalWorkoutSpeeds.length - 4].y);
    const speedRandomFactor = rng();
    if (wasTrendUp && currentSpeed < chunkMaxSpeed && speedRandomFactor > 0.7) {
      // Increase
      const delta = rng2Halves(0.5, Math.min((chunkMaxSpeed - currentSpeed), (aggressive ? 3 : 1.5)) + 0.1);
      currentSpeed += delta;
    } else if (wasTrendDown && currentSpeed > chunkMinSpeed && speedRandomFactor > 0.7) {
      // Decrease
      const delta = rng2Halves(0.5, Math.min((currentSpeed - chunkMinSpeed), (aggressive ? 3 : 1.5)) + 0.1);
      currentSpeed -= delta;
    } else {
      // Any direction is fine
      if ((speedRandomFactor > 0.6 || wasTrendLongNeutral) && currentSpeed < chunkMaxSpeed) {
        // Increase
        const delta = rng2Halves(0.5, Math.min((chunkMaxSpeed - currentSpeed), (aggressive ? 3 : 1.5)) + 0.1);
        currentSpeed += delta;
      } else if ((speedRandomFactor < 0.4 || wasTrendLongNeutral) && currentSpeed > chunkMinSpeed) {
        // Decrease
        const delta = rng2Halves(0.5, Math.min((currentSpeed - chunkMinSpeed), (aggressive ? 3 : 1.5)) + 0.1);
        currentSpeed -= delta;
      } else {
        // Speed remains the same
      }
    }
    // Sanity check
    if (currentSpeed < chunkMinSpeed) currentSpeed = chunkMinSpeed;
    if (currentSpeed > chunkMaxSpeed) currentSpeed = chunkMaxSpeed;

    // Determine incline
    currentIncline = globalWorkoutInclines[globalWorkoutInclines.length - 1].y;
    const chunkMinIncline = 1.5;
    const chunkMaxIncline = Math.min(currentIncline + 3, maxIncline, (currentSpeed >= 4.5 ? 3 : 99), (currentSpeed >= 6.5 ? 2 : 99));
    const wasInclineTrendUp = (globalWorkoutInclines[globalWorkoutInclines.length - 2].y < currentIncline);
    const wasInclineTrendDown = (globalWorkoutInclines[globalWorkoutInclines.length - 2].y > currentIncline);
    const inclineRandomFactor = rng();
    if (currentIncline < chunkMaxIncline && (hills ? inclineRandomFactor > 0.4 : wasInclineTrendUp && inclineRandomFactor > 0.7)) {
      // Increase
      const delta = rng2Halves(1, Math.min((chunkMaxIncline - currentIncline), 3) + 0.1);
      currentIncline += delta;
    } else if (currentIncline > chunkMinIncline && (hills ? inclineRandomFactor > 0.4 : wasInclineTrendDown && inclineRandomFactor > 0.7)) {
      // Decrease
      const delta = rng2Halves(1, Math.min((currentIncline - chunkMinIncline), 3) + 0.1);
      currentIncline -= delta;
    } else {
      // Any direction is fine
      if (inclineRandomFactor > 0.6 && currentIncline < chunkMaxIncline) {
        // Increase
        const delta = rng2Halves(1, Math.min((chunkMaxIncline - currentIncline), 3) + 0.1);
        currentIncline += delta;
      } else if (inclineRandomFactor < 0.4 && currentIncline > chunkMinIncline) {
        // Decrease
        const delta = rng2Halves(1, Math.min((currentIncline - chunkMinIncline), 3) + 0.1);
        currentIncline -= delta;
      } else {
        // Incline remains the same
      }
    }
    // Sanity check
    if (currentIncline < chunkMinIncline) currentIncline = chunkMinIncline;
    if (currentIncline > chunkMaxIncline) currentIncline = chunkMaxIncline;


    globalWorkoutSpeeds.push({x: time, y: currentSpeed});
    globalWorkoutInclines.push({x: time, y: currentIncline});
  }

  // Generate the cooldown
  currentSpeed = globalWorkoutSpeeds[globalWorkoutSpeeds.length - 1].y;
  const maxCooldownSpeed = Math.min(3.5, currentSpeed);
  currentSpeed = maxCooldownSpeed;
  currentIncline = 1.5;
  for (let i = 0; i < cooldownChunks; i++) {
    const time = globalWorkoutSpeeds.length * 1.5;
    globalWorkoutSpeeds.push({x: time, y: currentSpeed});
    globalWorkoutInclines.push({x: time, y: currentIncline});
    currentSpeed -= rng2Halves(0.5, 1.1);
    if (currentSpeed < 1) currentSpeed = 1;
  }

  // Extend cooldown to the end of allotted time
  currentSpeed = globalWorkoutSpeeds[globalWorkoutSpeeds.length - 1].y;
  currentIncline = 1.5;
  if (globalWorkoutSpeeds[globalWorkoutSpeeds.length - 1].x < totalTime) {
    globalWorkoutSpeeds.push({x: totalTime, y: currentSpeed});
    globalWorkoutInclines.push({x: totalTime, y: currentIncline});
  }

  showWorkoutChart(seed);
}

function showWorkoutChart(seed) {
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
          text: (seed >= 0 ? 'Workout, seed ' + seed : 'Workout'),
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

function createInstantWorkout(totalTime, maxSpeed, maxIncline, aggressive, hills) {
  document.getElementById('confWorkoutTime').value = totalTime;
  document.getElementById('confWorkoutMaxSpeed').value = maxSpeed;
  document.getElementById('confWorkoutMaxIncline').value = maxIncline;
  document.getElementById('confWorkoutAggressiveRamp').checked = aggressive;
  document.getElementById('confWorkoutHills').checked = hills;
  document.getElementById('confWorkoutSeed').value = '';
  generateWorkout();
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
  globalWorkoutCurrentSpeed = 0;
  globalWorkoutCurrentIncline = 0;
  acquireWakeLock();
  processCurrentWorkout();
  globalWorkoutRef = setInterval(() => processCurrentWorkout(), 5000);
  globalChartObject.update('none');
}

function stopWorkout() {
  if (globalWorkoutRef != null) {
    clearInterval(globalWorkoutRef);
    globalWorkoutRef = null;
  }
  releaseWakeLock();
  globalChartObject.update('none');
  // Send stop command
  renderTreadmillControlAudio(25.2, 25.2);
}

function processCurrentWorkout() {
  globalChartObject.update('none');
  const currentMinuteBy30SecIncrements = Math.floor((Date.now() - globalWorkoutStartTime) / 1000.0 / 60 * 2) / 2;

  if (currentMinuteBy30SecIncrements > globalWorkoutSpeeds[globalWorkoutSpeeds.length - 1].x) {
    // We're at the end of the workout
    stopWorkout();
    return;
  }

  let chunkIndex = 0;
  for (let i = 0; i < globalWorkoutSpeeds.length; i++) {
    if (globalWorkoutSpeeds[i].x > currentMinuteBy30SecIncrements) {
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

showWorkoutChart(-1);
