/**
  @param {import ("./instrumentPresets.js").Instrument} preset
  @param {AudioContext} audioContext
*/
export const createInstrument = (preset, audioContext) => {
  const {
    oscillators: oscillatorsInPreset,
    vibratoType,
    vibratoEffectOnLowPass,
    vibratoEffectOnPitch,
    vibratoEffectOnVolume,
    initialInstability,
    peakingFilters,
  } = preset;

  // Filters
  // Useful Q values (no idea exactly what they result in):
  // 2nd-order Butterworth: Qp = Math.SQRT1_2
  // 2nd-order Chebyshev (ripple 1 dB): Qp = 0.9565
  // 2nd-order Thomson-Bessel: Qp=0.5773
  // 4th-order Butterworth: Strage 1: Qp=0.5412; stage 2: Qp=1.3065
  const lowPassFilter = new BiquadFilterNode(audioContext, {
    type: "lowpass",
    frequency: 440,
    Q: Math.SQRT1_2,
  });

  const highPassFilter = new BiquadFilterNode(audioContext, {
    type: "highpass",
    frequency: 440,
    Q: Math.SQRT1_2,
  });

  lowPassFilter.connect(highPassFilter);

  let output = highPassFilter;
  let maxPeak = 1.0;

  if (peakingFilters.length > 0) {
    for (const { frequency, gain, Q } of peakingFilters) {
      maxPeak = Math.max(maxPeak, gain);
      const peakFilter = new BiquadFilterNode(audioContext, {
        type: "peaking",
        frequency: frequency,
        Q,
        gain,
      });

      output.connect(peakFilter);
      output = peakFilter;
    }
  }

  // Oscillators
  const oscillators = [];
  const baseVolume = 1.0 / maxPeak ** 0.41421356;

  for (const {
    type,
    pulseWidth = 0.5,
    pitchMultiplier = 1.0,
    gain = 1.0,
    attack,
    decay,
    sustain,
    release,
    glide,
  } of oscillatorsInPreset) {
    const oscillatorNode =
      type === "pulse"
        ? new PulseOscillatorNode(audioContext, { pulseWidth, frequency: 440 })
        : new OscillatorNode(audioContext, { type, frequency: 440 });
    const gainNode = new GainNode(audioContext, { gain: 0 });

    let oscillatorBaseVolume = 1.0;

    switch (type) {
      case "pulse": {
        oscillatorBaseVolume = (1.0 - pulseWidth * Math.SQRT1_2) ** 2.0;
        break;
      }
      case "square": {
        oscillatorBaseVolume = 0.414;
        break;
      }
      case "triangle": {
        oscillatorBaseVolume = 0.75;
        break;
      }
      case "sawtooth": {
        oscillatorBaseVolume = 0.666666;
        break;
      }
    }

    const gainTarget = oscillatorBaseVolume * (baseVolume * gain) ** 0.41421356;

    oscillatorNode.connect(gainNode).connect(lowPassFilter);
    oscillatorNode.start(audioContext.currentTime);
    oscillators.push({ oscillatorNode, gainNode, gainTarget, attack, decay, sustain, release, glide, pitchMultiplier });
  }

  // Vibrato oscillator (also used for instability and "idle vibrato")
  const idleVibratoFrequency = 13 / 60;
  const idleVibratoLowPassTarget = 400;
  const idleVibratoPitchTarget = 3;
  const idleVibratoVolumeTarget = 0.021 * baseVolume;

  // TODO: no need for this if there's no vibrato or instability at all?
  const vibratoMain = new OscillatorNode(audioContext, {
    type: vibratoType,
    frequency: idleVibratoFrequency,
  });

  // Low-pass vibrato ("brightness" vibrato)
  let vibratoLowPassGain = null;
  if (vibratoEffectOnLowPass > 0.0 || initialInstability > 0.0) {
    vibratoLowPassGain = new GainNode(audioContext, { gain: 0.0 });
    vibratoMain.connect(vibratoLowPassGain).connect(lowPassFilter.detune);
  }

  // Pitch vibrato
  let vibratoPitchGain = null;
  if (vibratoEffectOnPitch > 0.0) {
    vibratoPitchGain = new GainNode(audioContext, { gain: 0.0 });
    vibratoMain.connect(vibratoPitchGain);

    for (const { oscillatorNode } of oscillators) {
      vibratoPitchGain.connect(oscillatorNode.detune);
    }
  }

  // Volume vibrato ("tremolo")
  let vibratoVolumeGain = null;
  if (vibratoEffectOnVolume > 0.0) {
    vibratoVolumeGain = new GainNode(audioContext, { gain: 0.0 });
    vibratoMain.connect(vibratoVolumeGain);

    for (const { gainNode } of oscillators) {
      vibratoVolumeGain.connect(gainNode.gain);
    }
  }

  vibratoMain.start(audioContext.currentTime);

  return {
    oscillators,
    vibratoMain,
    vibratoLowPassGain,
    vibratoPitchGain,
    vibratoVolumeGain,
    lowPassFilter,
    highPassFilter,
    output,
    idleVibratoFrequency,
    idleVibratoLowPassTarget,
    idleVibratoPitchTarget,
    idleVibratoVolumeTarget,
    preset,
    startedPlayingAt: 0.0,
    willPlayUntil: 0.0,
    previousPitch: 440.0,
  };
};

export const playInstrument = (
  /** @type {ReturnType<typeof createInstrument>} */ instrument,
  /** @type {number} */ pitch,
  /** @type {number} */ at,
  /** @type {number} */ duration,
  velocity = 1.0,
  volume = 1.0,
  vibratoAmount = 0.0,
  vibratoFrequency = 5.0,
) => {
  const {
    oscillators,
    lowPassFilter,
    highPassFilter,
    vibratoMain,
    vibratoLowPassGain,
    vibratoPitchGain,
    vibratoVolumeGain,
    idleVibratoFrequency,
    idleVibratoLowPassTarget,
    idleVibratoPitchTarget,
    idleVibratoVolumeTarget,
    preset,
  } = instrument;

  const {
    decayImpactOnDuration,
    durationImpactOnDecay,
    initialInstability,
    attack: defaultAttack,
    decay: defaultDecay,
    sustain: defaultSustain,
    release: defaultRelease,
    glide: defaultGlide,
    filterAttack = defaultAttack,
    filterDecay = defaultDecay,
    filterSustain = defaultSustain,
    filterRelease = defaultRelease,
    lowPassFrequency,
    highPassFrequency,
    highPassPitchTracking,
    lowPassPitchTracking,
    vibratoEffectOnLowPass,
    vibratoEffectOnPitch,
    vibratoEffectOnVolume,
  } = preset;

  const hasVibrato = vibratoAmount > 0.0;

  let highPitchness = (pitch - highPassFrequency) / (lowPassFrequency - highPassFrequency);
  if (highPitchness > 0.0) highPitchness **= 0.41421356;
  const lowPitchness = Math.max(0.0, 1.0 - highPitchness);
  const relativePitchness = highPitchness * 2.0 - 1.0;
  const extremePitchness = Math.abs(relativePitchness);

  const volumeTarget = volume * (1.0 - 0.146 * extremePitchness);

  // NOTE: these will only work if the instrument is played sequentially
  const franticness = 0.236 ** Math.max(0.0, at - instrument.willPlayUntil);
  const pitchSameness = 0.09 ** Math.abs(Math.log(pitch) - Math.log(instrument.previousPitch)) * franticness;
  const pitchDifferentness = 1.0 - pitchSameness;

  const situationalDynamics = 0.91 + 0.09 * 2.0 * pitchDifferentness;
  const dynamicVelocity = velocity * situationalDynamics;
  const dynamicSlowness = 1.0 - dynamicVelocity;
  const glideDynamics = 0.91 + 0.09 * (dynamicSlowness + pitchSameness);

  const attackDynamics =
    mix(1.0, duration, 0.146) *
    (0.854 + 0.146 * 2.0 * lowPitchness) *
    (1.0 + 0.146 * dynamicSlowness) *
    situationalDynamics;
  const releaseDynamics =
    mix(1.0, duration, 0.146) *
    (0.854 + 0.146 * 2.0 * lowPitchness) *
    (1.0 - 0.146 * dynamicSlowness) *
    situationalDynamics;

  const defaultDynamicAttack = defaultAttack * attackDynamics;
  const defaultDynamicRelease = defaultRelease * releaseDynamics;

  const filterDynamicAttack = filterAttack * attackDynamics;
  const filterDynamicRelease = filterRelease * releaseDynamics;

  const vibratoAttack = defaultDynamicAttack * 0.09;
  const vibratoRelease = defaultDynamicRelease * 0.09;
  const vibratoGainAttack = defaultDynamicAttack * 0.236;
  const vibratoGainRelease = defaultDynamicRelease * 0.236;

  const highPassTarget =
    highPassPitchTracking < 0.0
      ? highPassFrequency * (1.0 - highPassPitchTracking * lowPitchness) // raises when negative
      : highPassFrequency / (1.0 + highPassPitchTracking * lowPitchness); // lowers when positive
  const lowPassTarget =
    lowPassPitchTracking < 0.0
      ? lowPassFrequency / (1.0 - lowPassPitchTracking * highPitchness) // lowers when negative
      : lowPassFrequency * (1.0 + lowPassPitchTracking * highPitchness); // raises when positive

  const idleVibratoTarget = idleVibratoFrequency * situationalDynamics;
  const vibratoTarget = hasVibrato ? vibratoFrequency : idleVibratoTarget;

  const vibratoLowPassTarget = hasVibrato ? vibratoAmount ** 0.5 * vibratoEffectOnLowPass : idleVibratoLowPassTarget;
  const vibratoPitchTarget = hasVibrato ? vibratoAmount * vibratoEffectOnPitch : idleVibratoPitchTarget;
  const vibratoVolumeTarget = (hasVibrato ? vibratoAmount * -vibratoEffectOnVolume : -idleVibratoVolumeTarget) * volume;

  // Start and end
  const startAt = at;
  const decayAt = startAt + defaultDynamicAttack * 4.0;
  let endAt = at + Math.max(duration * 0.618, duration - defaultDynamicRelease);

  const instabilityStopsAt =
    initialInstability > 0.0 ? Math.min(endAt - Number.EPSILON * 2.0, startAt + filterDynamicAttack * 6.0) : startAt;
  const vibratoAt = Math.min(endAt - Number.EPSILON, instabilityStopsAt + defaultDynamicAttack);

  const shouldDecay = defaultDecay > 0.0 && defaultSustain !== 1.0 && decayAt < endAt;

  // Cancel pending events
  lowPassFilter.frequency.cancelScheduledValues(startAt);
  highPassFilter.frequency.cancelScheduledValues(startAt);
  vibratoMain.frequency.cancelScheduledValues(startAt);
  vibratoLowPassGain?.gain.cancelScheduledValues(startAt);

  // also fire up oscillators, and attack amplitudes
  for (const {
    oscillatorNode,
    gainNode,
    gainTarget,
    attack = defaultAttack,
    glide = defaultGlide,
    pitchMultiplier,
  } of oscillators) {
    oscillatorNode.frequency.cancelScheduledValues(startAt);
    gainNode.gain.cancelScheduledValues(startAt);

    oscillatorNode.frequency.setTargetAtTime(pitch * pitchMultiplier, startAt, glide * glideDynamics);
    gainNode.gain.setTargetAtTime(gainTarget * volumeTarget, startAt, attack * attackDynamics);
  }

  // Attack filters
  lowPassFilter.frequency.setTargetAtTime(lowPassTarget, startAt, filterDynamicAttack);
  highPassFilter.frequency.setTargetAtTime(highPassTarget, startAt, filterDynamicAttack);

  // Brass-style instability at start of notes
  if (initialInstability > 0.0) {
    const instabilityTarget = 78 + 4 * highPitchness;
    const instabilityEffect = initialInstability * (200.0 + 500.0 * pitchDifferentness);
    const instabilityGlide = 0.001;
    const instabilityDecaysAt = startAt + instabilityGlide * 4.0;

    const instabilityGainDecay = instabilityStopsAt - instabilityDecaysAt;

    vibratoMain.frequency.setTargetAtTime(instabilityTarget, startAt, instabilityGlide);
    vibratoLowPassGain?.gain.setTargetAtTime(instabilityEffect, startAt, instabilityGlide);

    vibratoLowPassGain?.gain.setTargetAtTime(0.0, instabilityDecaysAt, instabilityGainDecay);
    vibratoMain.frequency.setTargetAtTime(idleVibratoTarget, instabilityStopsAt, instabilityGlide);
  }

  // Fire up vibrato: idle or not
  vibratoMain.frequency.setTargetAtTime(vibratoTarget, vibratoAt, vibratoAttack);
  vibratoLowPassGain?.gain.setTargetAtTime(vibratoLowPassTarget, vibratoAt, vibratoGainAttack);
  vibratoPitchGain?.gain.setTargetAtTime(vibratoPitchTarget, vibratoAt, vibratoGainAttack);
  vibratoVolumeGain?.gain.setTargetAtTime(vibratoVolumeTarget, vibratoAt, vibratoGainAttack);

  // Decay if needed
  if (shouldDecay) {
    const decayDynamics = 0.764 + 0.236 * 2.0 * lowPitchness;

    const decayDuration = endAt - decayAt;
    const decayTarget = decayDuration / 2.0;
    const decayInterpolation = 0.333333 * durationImpactOnDecay;

    const oscillatorDecayDynamics = decayDynamics * (1.0 - 0.146 * dynamicSlowness);
    const filterDecayDynamics = decayDynamics * (1.0 + 0.146 * dynamicSlowness);

    const sustainDynamics = 1.0 + highPitchness * 0.236;

    // Oscillators
    for (const { gainNode, gainTarget, decay = defaultDecay, sustain = defaultSustain } of oscillators) {
      const dynamicDecay = mix(decay, decayTarget, decayInterpolation) * oscillatorDecayDynamics;

      if (decayImpactOnDuration > 0.0) endAt = Math.max(endAt, decayAt + dynamicDecay * 3.0 * decayImpactOnDuration);

      gainNode.gain.setTargetAtTime(gainTarget * volume * sustain ** sustainDynamics, decayAt, dynamicDecay);
    }

    // Filters
    const filterDynamicDecay = mix(filterDecay, decayTarget, decayInterpolation) * filterDecayDynamics;
    const filterDynamicSustain = filterSustain ** sustainDynamics;

    lowPassFilter.frequency.setTargetAtTime(
      mix(pitch, lowPassTarget, filterDynamicSustain),
      decayAt,
      filterDynamicDecay,
    );
    highPassFilter.frequency.setTargetAtTime(
      mix(pitch, highPassTarget, filterDynamicSustain),
      decayAt,
      filterDynamicDecay,
    );
  }

  // Release
  for (const { gainNode, release = defaultRelease } of oscillators) {
    gainNode.gain.setTargetAtTime(0.0, endAt, release * releaseDynamics);
  }

  lowPassFilter.frequency.setTargetAtTime(pitch, endAt, filterDynamicRelease);
  highPassFilter.frequency.setTargetAtTime(pitch, endAt, filterDynamicRelease);

  vibratoMain.frequency.setTargetAtTime(idleVibratoTarget, endAt, vibratoRelease);
  vibratoLowPassGain?.gain.setTargetAtTime(0.0, endAt, vibratoGainRelease);
  vibratoPitchGain?.gain.setTargetAtTime(0.0, endAt, vibratoGainRelease);
  vibratoVolumeGain?.gain.setTargetAtTime(0.0, endAt, vibratoGainRelease);

  // Metadata
  instrument.startedPlayingAt = startAt;
  instrument.willPlayUntil = endAt;
  instrument.previousPitch = pitch;
};

/**
  @param {ReturnType<typeof createInstrument>} instrument
*/
export const destroyInstrument = ({ output, oscillators, vibratoMain }) => {
  // TODO: Is this all that's needed?
  // Or do all nodes need to be disconnected?

  output.disconnect();
  for (const { oscillatorNode } of oscillators) {
    oscillatorNode.stop();
    oscillatorNode.disconnect();
  }
  vibratoMain.stop();
  vibratoMain.disconnect();
};

function mix(a = 0.0, b = 1.0, amount = 0.5) {
  return a + amount * (b - a);
}

class PulseOscillatorNode extends OscillatorNode {
  /**
    @param {AudioContext} audioContext
  */
  constructor(audioContext, options = {}) {
    super(audioContext, { ...options, type: "sawtooth" });

    const width = options?.pulseWidth ?? 0.5;
    const resolution = 1.0 / width;
    const relativeWidth = width * resolution;

    const curve = new Float32Array(resolution);
    curve.fill(-1.0, 0, relativeWidth);
    curve.fill(1.0, relativeWidth);

    this.waveShaper = new WaveShaperNode(audioContext, { curve, oversample: "4x" });
    super.connect(this.waveShaper);
  }

  // FIXME: dunno how to type these bloody things correctly
  // using .call instead didn't seem to work, because args were not truly undefined?
  /** @param {Parameters<WaveShaperNode["connect"]>} args */
  connect(...args) {
    return this.waveShaper.connect.apply(this.waveShaper, args);
  }

  /** @param {Parameters<WaveShaperNode["disconnect"]>} args */
  disconnect(...args) {
    return this.waveShaper.disconnect.apply(this.waveShaper, args);
  }
}
