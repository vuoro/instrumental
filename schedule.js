const schedules = new WeakMap();

/**
 *
 * @typedef {typeof import("./instrumentPresets.js").genericInstrument} Instrument
 * @typedef {{scale?: number, velocity?: number, volume?: number, vibrato?: number, transpose?: number, root?: number, alternate?: boolean, chord?: boolean}} PlayableOptions
 * @typedef {(PlayableOptions | number | undefined | Playable)[]} Playable
 * @typedef {(instrument: Instrument, playable: Playable | number, root: number, at: number, duration: number, velocity: number, volume: number, vibrato: number) => void} PlayNote
 * @param {([Instrument, Playable])[]} tracks
 * @param {number} cycle
 * @param {AudioContext} audioContext
 * @param {PlayNote} playNote
 */
export const scheduleMusic = (tracks, cycle, audioContext, playNote, safetyMargin = 0.2) => {
  const { currentTime } = audioContext;
  if (audioContext.state !== "running") return;

  // TODO: type pendingNote
  const schedule =
    schedules.get(audioContext) ||
    schedules
      .set(audioContext, {
        scheduledUpTo: 0.0,
        pendingNote: Object.seal({
          pending: false,
          instrument: null,
          note: 0,
          root: 0,
          at: 0,
          duration: 0,
          velocity: 0,
          volume: 0,
          vibrato: 0,
        }),
      })
      .get(audioContext);

  // TODO: use baseLatency to better with sounds with visuals?

  // Skip to current time if needed
  if (schedule.scheduledUpTo < currentTime) {
    schedule.scheduledUpTo += currentTime + safetyMargin - schedule.scheduledUpTo;
  }

  const scheduleAheadBy = document.hidden ? 1.0 + safetyMargin : safetyMargin;

  if (schedule.scheduledUpTo < currentTime + scheduleAheadBy) {
    const from = schedule.scheduledUpTo;
    const to = currentTime + scheduleAheadBy;
    schedule.scheduledUpTo = to;

    const cycleEndsAt = (Math.floor(from / cycle) + 1.0) * cycle;
    const cyclesToCheck = to > cycleEndsAt ? 2 : 1;

    // Schedule as much of the ongoing cycle as we can reach
    for (const [instrument, sequence] of tracks) {
      let checkedCycles = 0;

      while (checkedCycles < cyclesToCheck || schedule.pendingNote.pending) {
        const cycleStartedAt = (Math.floor(from / cycle) + checkedCycles) * cycle;
        const period = cycleStartedAt / cycle;

        schedulePart(schedule.pendingNote, playNote, instrument, sequence, cycleStartedAt, cycle, period, from, to);

        checkedCycles++;
        if (checkedCycles > 64)
          throw new Error(
            "scheduleMusic tried to loop way too many times: either the cycle is too short or the tracks are messed up",
          );
      }
    }
  }
};

/**
   @param {PlayNote} playNote
   @param {Instrument} instrument
   @param {Playable | number | undefined} playable
   @param {number} velocityFromParent
   @param {number} volumeFromParent
   @param {number} vibratoFromParent
   @param {number} transposeFromParent
   @param {number} rootFromParent
 */
const schedulePart = (
  pendingNote,
  playNote,
  instrument,
  playable,
  at = 0.0,
  duration = 0.0,
  period = 0.0,
  from = 0.0,
  to = 0.0,
  velocityFromParent = undefined,
  volumeFromParent = undefined,
  vibratoFromParent = undefined,
  transposeFromParent = undefined,
  rootFromParent = undefined,
) => {
  if (at > to && !pendingNote.pending) return;

  if (typeof playable === "number") {
    if (at < from) return;

    // End pending note, if there is one
    if (pendingNote.pending) {
      pendingNote.pending = false;
      // console.log(pendingNote.note, "end from note");
      playNote(
        pendingNote.instrument,
        pendingNote.note,
        pendingNote.root,
        pendingNote.at,
        pendingNote.duration,
        pendingNote.velocity,
        pendingNote.volume,
        pendingNote.vibrato,
      );
    }

    // Start a new note if it's within reach
    if (at > to) return;

    const note = playable + (transposeFromParent ?? 0);
    const root = rootFromParent || 0;
    const velocity = velocityFromParent;
    const volume = volumeFromParent;
    const vibrato = vibratoFromParent;

    // console.log(note, "start");

    pendingNote.instrument = instrument;
    pendingNote.note = note;
    pendingNote.root = root;
    pendingNote.at = at;
    pendingNote.duration = duration;
    pendingNote.velocity = velocity;
    pendingNote.volume = volume;
    pendingNote.vibrato = vibrato;

    pendingNote.pending = true;
    return;
  }

  // Skip nulls, but also make them end pending notes
  if (playable === null) {
    if (pendingNote.pending) {
      pendingNote.pending = false;
      // console.log(pendingNote.note, "end from pause");
      playNote(
        pendingNote.instrument,
        pendingNote.note,
        pendingNote.root,
        pendingNote.at,
        pendingNote.duration,
        pendingNote.velocity,
        pendingNote.volume,
        pendingNote.vibrato,
      );
    }
    return;
  }

  // If extender, extend pending note
  if (playable === undefined && pendingNote.pending) {
    // console.log(pendingNote.note, "extend");
    pendingNote.duration += duration;
    return;
  }

  // Skip unknowns
  if (!Array.isArray(playable)) return;

  // Merge options
  let amountOfOptions = 0;
  let alternate = false;
  let chord = false;

  let velocity = velocityFromParent;
  let volume = volumeFromParent;
  let vibrato = vibratoFromParent;
  let transpose = transposeFromParent;
  let root = rootFromParent;

  for (let index = 0; index < playable.length; index++) {
    const child = playable[index];

    if (child && typeof child === "object" && !Array.isArray(child) && !ArrayBuffer.isView(child)) {
      velocity = child.velocity ?? velocity;
      volume = child.volume ?? volume;
      vibrato = child.vibrato ?? vibrato;
      transpose = child.transpose ?? transpose;
      root = child.root ?? root;

      alternate = alternate || child.alternate;
      chord = chord || child.chord;

      amountOfOptions++;
    }
  }

  const length = playable.length - amountOfOptions;

  // Alternators pick 1 playable, based on the current period
  if (alternate) {
    const index = Math.round(period) % length;
    const child = playable[index];
    const childPeriod = (period - index) / length;

    return schedulePart(
      pendingNote,
      playNote,
      instrument,
      // FIXME: recursive types…
      child,
      at,
      duration,
      childPeriod,
      from,
      to,
      velocity,
      volume,
      vibrato,
      transpose,
      root,
    );
  }

  // Chord play all playables on top of each other
  if (chord) {
    for (let index = 0; index < length; index++) {
      const child = playable[index];

      schedulePart(
        pendingNote,
        playNote,
        instrument,
        child,
        at,
        duration,
        period,
        from,
        to,
        velocity,
        volume,
        vibrato,
        transpose,
        root,
      );
    }

    return;
  }

  // Normal sequences subdivide time
  const childDuration = duration / length;

  for (let index = 0; index < length; index++) {
    const child = playable[index];
    const childAt = at + index * childDuration;

    schedulePart(
      pendingNote,
      playNote,
      instrument,
      child,
      childAt,
      childDuration,
      period,
      from,
      to,
      velocity,
      volume,
      vibrato,
      transpose,
      root,
    );
  }
};
