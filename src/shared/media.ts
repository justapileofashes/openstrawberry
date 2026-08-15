export type MediaState = {
  available: boolean;
  pictureInPictureSupported: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  title: string;
  message?: string;
};

export type MediaCommand =
  | { action: "refresh" }
  | { action: "play" }
  | { action: "pause" }
  | { action: "toggle" }
  | { action: "seek"; value: number }
  | { action: "volume"; value: number }
  | { action: "mute" }
  | { action: "picture-in-picture" };

export const EMPTY_MEDIA_STATE: MediaState = {
  available: false,
  pictureInPictureSupported: false,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  title: "No active media"
};
