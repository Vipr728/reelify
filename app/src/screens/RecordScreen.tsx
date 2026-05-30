// Snapchat-style vertical clip recorder.
// Records short (<=15s) vertical clips using expo-camera (Expo Go-compatible).
// Each finished clip uploads to Box immediately and shows a per-clip upload
// chip. The 15s cap is enforced natively via recordAsync's maxDuration; a JS
// timer drives the on-screen countdown only.
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
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { uploadClip } from '../lib/upload';
import { colors, spacing, radius } from '../lib/theme';
import { MAX_CLIP_DURATION_S } from '../lib/config';

type UploadStatus = 'uploading' | 'done' | 'failed';
interface PendingUpload {
  id: number;
  uri: string;
  status: UploadStatus;
  error?: string;
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

export default function RecordScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const [cameraPerm, requestCameraPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  const [appActive, setAppActive] = useState<boolean>(
    AppState.currentState === 'active',
  );
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);

  const cameraRef = useRef<CameraView | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextIdRef = useRef(0);

  const hasPermission = !!cameraPerm?.granted && !!micPerm?.granted;
  const isActive = isFocused && appActive && hasPermission;

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      setAppActive(next === 'active');
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (cameraPerm && !cameraPerm.granted && cameraPerm.canAskAgain) {
      void requestCameraPerm();
    }
    if (micPerm && !micPerm.granted && micPerm.canAskAgain) {
      void requestMicPerm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraPerm?.granted, micPerm?.granted]);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

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

  const handleRecordingError = useCallback(
    (error: Error) => {
      clearTimer();
      setIsRecording(false);
      setElapsed(0);
      const id = nextIdRef.current++;
      setUploads((prev) => [
        ...prev,
        { id, uri: '', status: 'failed', error: error.message },
      ]);
    },
    [clearTimer],
  );

  const startRecording = useCallback(async () => {
    const cam = cameraRef.current;
    if (isRecording || cam == null) return;

    setIsRecording(true);
    setElapsed(0);
    clearTimer();
    timerRef.current = setInterval(() => {
      setElapsed((e) => Math.min(e + 1, MAX_CLIP_DURATION_S));
    }, 1000);

    try {
      // recordAsync resolves with { uri } when stopRecording() is called or
      // maxDuration elapses. iOS produces a .mov file at a tmp path.
      const result = await cam.recordAsync({
        maxDuration: MAX_CLIP_DURATION_S,
      });
      clearTimer();
      setIsRecording(false);
      setElapsed(0);
      if (result?.uri) {
        const id = nextIdRef.current++;
        setUploads((prev) => [
          ...prev,
          { id, uri: result.uri, status: 'uploading' },
        ]);
        void startUpload(id, result.uri);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Recording failed';
      handleRecordingError(new Error(message));
    }
  }, [isRecording, clearTimer, startUpload, handleRecordingError]);

  const stopRecording = useCallback(() => {
    const cam = cameraRef.current;
    if (cam == null) return;
    try {
      cam.stopRecording();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stop failed';
      handleRecordingError(new Error(message));
    }
  }, [handleRecordingError]);

  const onPressRecordButton = useCallback(() => {
    if (isRecording) stopRecording();
    else void startRecording();
  }, [isRecording, startRecording, stopRecording]);

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
    const canAsk =
      (cameraPerm?.canAskAgain ?? true) || (micPerm?.canAskAgain ?? true);
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
            void requestCameraPerm();
            void requestMicPerm();
          }}
        >
          <Text style={styles.gateButtonText}>
            {canAsk ? 'Grant access' : 'Open Settings to allow'}
          </Text>
        </Pressable>
      </View>
    );
  }

  // --- Recorder UI --------------------------------------------------------
  return (
    <View style={styles.root}>
      {isActive ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          mode="video"
          facing="back"
          mute={false}
          videoQuality="1080p"
        />
      ) : null}

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
