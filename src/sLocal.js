let boxId = 0;
let reactionId = 0;

// Current reaction
let rxActive = undefined;
// To skip the subbed consistency check during an s(box) read
let sRead = false;
// Transactions
let transactionBoxes = new Set();
// Last error (gzip 701 to 688)
let error;

// Registry of reaction parents (and therefore all known reactions)
const rxTree = new WeakMap();

// Unique value to compare with `===` since Symbol() doesn't gzip well
const BOX_NEXT_EMPTY     = new Symbol();
const STATE_ON           = new Symbol();
const STATE_PAUSED       = new Symbol();
const STATE_PAUSED_STALE = new Symbol();
const STATE_OFF          = new Symbol();

const createRx = (fn) => {
  const rx = () => _rxRun(rx);
  rx.id = `R${reactionId++}=${fn.name}`;
  rx.fn = fn;
  rx.sr = new Set(); // Set<Box>
  rx.pr = new Set(); // Set<Box>
  rx.runs = 0;
  rx.children = new Set(); // Set<Rx>
  rx.state = STATE_ON;
  rx.pause = () => _rxPause(rx);
  rx.unsubscribe = () => _rxUnsubscribe(rx);
  // console.log(`Created ${rx.id}`, rxActive ? `; child of ${rxActive.id}` : '');
  rxTree.set(rx, rxActive); // Maybe undefined; that's fine
  if (rxActive) rxActive.children.push(rx);
  rx();
  return rx;
};

// This takes a meta object because honestly you shouldn't use it directly?
const _rxRun = (rx) => {
  if (rx.state === STATE_PAUSED) {
    // The reaction never reached PAUSED_STALE so nothing's changed. Maybe our
    // children need to update though:
    rx.state = STATE_ON;
    rx.children.forEach(_rxRun);
    return;
  }
  // Define the subscription function
  const s = box => {
    if (rx.pr.has(box)) throw new Error(`Mixed pr/sr ${box.id}`);
    // Add to box.rx first so it throws if s() wasn't passed a box...
    box.rx.add(rx);
    rx.sr.add(box);
    // console.log(`s() ${rx.id} 🔗 ${box.id}`);
    sRead = true;
    const value = box();
    sRead = false;
    return value;
  };
  const prev = rxActive;
  rxActive = rx;
  // Drop everything in the tree like Sinuous/S.js "automatic memory management"
  _rxUnsubscribe(rx);
  try {
    error = undefined;
    rx.fn(s);
    rx.runs++;
    if (rx.sr.size) rx.state = STATE_ON;
    // console.log(`Run ${rx.runs}: ${rx.sr.size}sr ${rx.pr.size}pr`);
  } catch (err) {
    error = err;
  }
  rxActive = prev;
  if (error) throw error;
};

const _rxUnsubscribe = (rx) => {
  // Skip if the reaction has never run; there aren't any connections
  if (!rx.runs) return;
  rx.children.forEach(_rxUnsubscribe);
  rx.children = new Set();
  rx.sr.forEach(box => box.rx.delete(rx));
  rx.sr = new Set();
  rx.pr = new Set();
  rx.state = STATE_OFF;
};

const _rxPause = (rx) => {
  rx.children.forEach(_rxPause);
  rx.state = STATE_PAUSED;
};

const createBox = (k, v) => {
  // Hide the stored value in a closure and not as a property of the box
  let saved = v;
  const box = (...args) => {
    if (args.length) {
      const [nextValue] = args;
      // console.log(`Write ${box.id}:`, saved, '➡', nextValue, `Notifying ${box.rx.size} reactions`);
      if (transactionBoxes) {
        transactionBoxes.add(box);
        box.next = nextValue;
        // Don't save
        return;
      }
      saved = nextValue;
      // Duplicate the set else it's an infinite loop...
      // Needs to be ordered by parent->child
      const toRun = new Set(box.rx);
      toRun.forEach(rx => {
        const rxParent = rxTree.get(rx);
        if (rxParent && toRun.has(rxParent)) {
          // Parent has unsubscribed (rx.state === STATE_OFF)
          // This rx has been superceded; unfortunately
          rx = rxParent;
        }
        if (rx.state === STATE_PAUSED) rx.state = STATE_PAUSED_STALE;
        else _rxRun(rx);
      });
      // Don't return a value; keeps it simple
      return;
    }
    // if (rxActive) {
    //   console.log(sRead
    //     ? `Sub-read ${box.id}; rxActive ${rxActive.id}`
    //     : `Pass-read ${box.id}; rxActive ${rxActive.id}`
    //   );
    // }
    if (rxActive && !sRead) {
      if (rxActive.sr.has(box)) throw new Error(`Mixed sr/pr ${box.id}`);
      rxActive.pr.add(box);
    }
    return saved;
  };
  box.id = `B${boxId++}=${k}`;
  box.rx = new Set();
  box.next = BOX_NEXT_EMPTY;
  return box;
};

const createBoxes = obj => {
  Object.keys(obj).forEach(k => { obj[k] = createBox(k, obj[k]); });
  return obj;
};

const transaction = (fn) => {
  const prev = transactionBoxes;
  transactionBoxes = new Set();
  const value = fn();
  const boxes = transactionBoxes;
  transactionBoxes = prev;
  boxes.forEach(box => {
    // XXX: Sinuous does `if (box.next !== BOX_NEXT_EMPTY) { ... }` wrapper
    const { next } = box;
    box.next = BOX_NEXT_EMPTY;
    box(next);
  });
  return value;
};

const adopt = (rxParent, fn) => {
  const prev = rxActive;
  rxActive = rxParent;
  let ret;
  try {
    error = undefined;
    ret = fn();
  } catch (err) {
    error = err;
  }
  rxActive = prev;
  if (error) throw error;
  return ret;
};

export { createRx as rx, createBoxes as boxes, transaction, adopt, rxTree };
