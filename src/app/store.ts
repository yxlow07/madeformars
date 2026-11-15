// One tiny state store shared by every mode (hash routes #planet, #frame, #sim, #debrief).
import type { Place } from "./search";

export type Mode = "SPLASH" | "PLANET" | "FRAME" | "SIM" | "DEBRIEF";

export interface Selection extends Place { elev?: number; nearest?: string }

export interface State {
  mode: Mode;
  selected: Selection | null;
  routeExists: boolean;
}

type Listener = (s: State, prev: State) => void;

class Store {
  state: State = { mode: "SPLASH", selected: null, routeExists: false };
  private listeners = new Set<Listener>();
  set(patch: Partial<State>) {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const l of this.listeners) l(this.state, prev);
  }
  on(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
}

export const store = new Store();
