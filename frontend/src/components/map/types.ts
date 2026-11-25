export type Point = { latitude: number; longitude: number };

export type EventMapProps = {
  /** Where the pin is. */
  pin: Point | null;
  /** Where the map looks when there is no pin. */
  center?: Point | null;
  /** The person who created the event: a click or a drag moves the pin. */
  editable?: boolean;
  onPin?: (point: Point) => void;
  /** What a screen reader says about the map. */
  label: string;
  height?: number | '100%';
};

export type EventMapHandle = {
  /** The pin where the map is looking: the way to place it with the keyboard. */
  pinAtCenter: () => void;
  lookAt: (point: Point) => void;
};
