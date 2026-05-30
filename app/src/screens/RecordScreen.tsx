// Snapchat-style vertical clip recorder.
// Records short (<=15s) vertical clips with react-native-vision-camera v5
// (Nitro rewrite). Each finished clip uploads to Box immediately and shows a
// per-clip upload chip. The 15s cap is enforced natively via Recorder
// maxDuration; a JS timer drives the on-screen countdown only.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  useMicrophonePermission,
  useVideoOutput,
} from 'react-native-vision-camera';
import type { Recorder, RecorderFileType } from 'react-native-vision-camera';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { uploadClip } from '../lib/upload';
import { colors, spacing, radius } from '../lib/theme';
import { MAX_CLIP_DURATION_S } from '../lib/config';

// A single in-flight / completed upload, surfaced as a chip at the top.
type UploadStatus = 'uploading' | 'done' | 'failed';
interface PendingUpload {
  id: number;
  uri: string;
  status: UploadStatus;
  error?: string;
}

// vision-camera returns a bare filesystem path. fileType 'mp4' is iOS-valid;
// the worker normalizes to 1080x1920 later, output orientation handles portrait.
const FILE_TYPE: RecorderFileType = 'mp4';

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

export default function RecordScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const device = useCameraDevice('back');
  const camera = useCameraPermission();
  const mic = useMicrophonePermission();
  const videoOutput = useVideoOutput({
    targetResolution: CommonResolutions.FHD_16_9,
    enableAudio: true,
    fileType: FILE_TYPE,
  });

  // Camera session must run only when focused AND foregrounded.
  const [appActive, setAppActive] = useState<boolean>(
    AppState.currentState === 'active',
  );
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);

  // The single-use Recorder for the in-flight clip (one Recorder per clip).
  const recorderRef = useRef<Recorder | null>(null);
  // Drives the on-screen countdown; native maxDuration owns the hard stop.
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Stable incrementing id for upload chips (never Date.now() in render).
  const nextIdRef = useRef(0);

  const hasPermission = camera.hasPermission && mic.hasPermission;
  const isActive = isFocused && appActive && hasPermission;

  // Track app foreground/background so the camera session pauses in background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      setAppActive(next === 'active');
    });
    return () => sub.remove();
  }, []);

  // Request camera + mic up front if not already granted.
  useEffect(() => {
    if (!camera.hasPermission) void camera.requestPermission();
    if (!mic.hasPermission) void mic.requestPermission();
    // Only run on mount-ish; permission objects are stable per status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  // Kick off the upload for a finished clip and track its status as a chip.
  const startUpload = useCallback(async (id: number, uri: string) => {
    try {
      await uploadClip(uri);
      setUploads((prev) =>
        prev.map((u) => (u.id === id ? { ...u, status: 'done' } : u)),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setUploads((prev) =>
        prev.map((u) =>
          u.id === id ? { ...u, status: 'failed', error: message } : u,
        ),
      );
    }
  }, []);

  // Called from the recorder's onRecordingFinished. uri is a bare fs path.
  const handleFinished = useCallback(
    (uri: string) => {
      clearTimer();
      setIsRecording(false);
      setElapsed(0);
      recorderRef.current = null;

      const id = nextIdRef.current++;
      setUploads((prev) => [...prev, { id, uri, status: 'uploading' }]);
      void startUpload(id, uri);
    },
    [clearTimer, startUpload],
  );

  // Reset recording UI if the recorder errors out mid-clip.
  const handleRecordingError = useCallback(
    (error: Error) => {
      clearTimer();
      setIsRecording(false);
      setElapsed(0);
      recorderRef.current = null;
      // Surface the failure as a chip so the user isn't left guessing.
      const id = nextIdRef.current++;
      setUploads((prev) => [
        ...prev,
        { id, uri: '', status: 'failed', error: error.message },
      ]);
    },
    [clearTimer],
  );

  const startRecording = useCallback(async () => {
    if (isRecording || recorderRef.current != null) return;
    try {
      // A Recorder records exactly once: create a fresh one per clip.
      const recorder = await videoOutput.createRecorder({
        maxDuration: MAX_CLIP_DURATION_S,
      });
      recorderRef.current = recorder;

      setIsRecording(true);
      setElapsed(0);
      clearTimer();
      timerRef.current = setInterval(() => {
        setElapsed((e) => Math.min(e + 1, MAX_CLIP_DURATION_S));
      }, 1000);

      await recorder.startRecording(
        (filePath: string) => handleFinished(filePath),
        (error: Error) => handleRecordingError(error),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Recording failed';
      handleRecordingError(new Error(message));
    }
  }, [
    isRecording,
    videoOutput,
    clearTimer,
    handleFinished,
    handleRecordingError,
  ]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder == null) return;
    try {
      // onRecordingFinished fires after this (reason 'stopped').
      await recorder.stopRecording();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stop failed';
      handleRecordingError(new Error(message));
    }
  }, [handleRecordingError]);

  const onPressRecordButton = useCallback(() => {
    if (isRecording) void stopRecording();
    else void startRecording();
  }, [isRecording, startRecording, stopRecording]);

  // Tapping a failed chip retries its upload (if it has a usable uri).
  const onRetry = useCallback(
    (item: PendingUpload) => {
      if (item.status !== 'failed' || item.uri.length === 0) return;
      setUploads((prev) =>
        prev.map((u) =>
          u.id === item.id ? { ...u, status: 'uploading', error: undefined } : u,
        ),
      );
      void startUpload(item.id, item.uri);
    },
    [startUpload],
  );

  const progress = useMemo(
    () => Math.min(1, elapsed / MAX_CLIP_DURATION_S),
    [elapsed],
  );

  // --- Permission gate ----------------------------------------------------
  if (!hasPermission) {
    const canAsk = camera.canRequestPermission || mic.canRequestPermission;
    return (
      <View style={styles.gate}>
        <Text style={styles.gateTitle}>Camera & microphone needed</Text>
        <Text style={styles.gateBody}>
          Reelify records short vertical clips. Grant camera and microphone
          access to start recording.
        </Text>
        <Pressable
          style={styles.gateButton}
          onPress={() => {
            if (!camera.hasPermission) void camera.requestPermission();
            if (!mic.hasPermission) void mic.requestPermission();
          }}
        >
          <Text style={styles.gateButtonText}>
            {canAsk ? 'Grant access' : 'Open Settings to allow'}
          </Text>
        </Pressable>
      </View>
    );
  }

  // --- No camera fallback -------------------------------------------------
  if (device == null) {
    return (
      <View style={styles.gate}>
        <Text style={styles.gateTitle}>No camera available</Text>
        <Text style={styles.gateBody}>
          This device has no usable back camera.
        </Text>
      </View>
    );
  }

  // --- Recorder UI --------------------------------------------------------
  return (
    <View style={styles.root}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        outputs={[videoOutput]}
        isActive={isActive}
      />

      {/* Upload chips, top overlay. */}
      <View style={[styles.chipStrip, { top: insets.top + spacing.sm }]}>
        {uploads.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => onRetry(item)}
            disabled={item.status !== 'failed'}
            style={[styles.chip, chipStyle(item.status)]}
          >
            {item.status === 'uploading' ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : null}
            <Text style={styles.chipText}>
              {item.status === 'uploading'
                ? 'Uploading…'
                : item.status === 'done'
                  ? 'Uploaded'
                  : 'Failed — tap to retry'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Elapsed timer + progress bar, shown only while recording. */}
      {isRecording ? (
        <View style={[styles.timerWrap, { top: insets.top + spacing.xl + 24 }]}>
          <Text style={styles.timerText}>
            {formatTime(elapsed)} / {formatTime(MAX_CLIP_DURATION_S)}
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
        </View>
      ) : null}

      {/* Record / stop button, bottom center. */}
      <View style={[styles.controls, { bottom: insets.bottom + spacing.xl }]}>
        <Pressable
          onPress={onPressRecordButton}
          style={({ pressed }) => [
            styles.recordOuter,
            pressed && styles.recordPressed,
          ]}
        >
          <View
            style={isRecording ? styles.recordInnerStop : styles.recordInnerIdle}
          />
        </Pressable>
      </View>
    </View>
  );
}

function chipStyle(status: UploadStatus) {
  switch (status) {
    case 'done':
      return { borderColor: colors.success };
    case 'failed':
      return { borderColor: colors.danger };
    default:
      return { borderColor: colors.border };
  }
}

const RECORD_OUTER = 78;
const RECORD_INNER = 62;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  // Permission / fallback gate.
  gate: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  gateTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  gateBody: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  gateButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  gateButtonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  // Upload chips.
  chipStrip: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: 'rgba(11,11,15,0.72)',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  // Timer + progress.
  timerWrap: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    alignItems: 'center',
    gap: spacing.sm,
  },
  timerText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    backgroundColor: 'rgba(11,11,15,0.55)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  progressTrack: {
    width: '60%',
    height: 4,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent,
  },
  // Record button.
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  recordOuter: {
    width: RECORD_OUTER,
    height: RECORD_OUTER,
    borderRadius: RECORD_OUTER / 2,
    borderWidth: 4,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordPressed: {
    opacity: 0.7,
  },
  recordInnerIdle: {
    width: RECORD_INNER,
    height: RECORD_INNER,
    borderRadius: RECORD_INNER / 2,
    backgroundColor: colors.accent,
  },
  recordInnerStop: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: colors.accent,
  },
});
