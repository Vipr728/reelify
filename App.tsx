import { useEvent } from 'expo';
import { fetch as expoFetch } from 'expo/fetch';
import { StatusBar } from 'expo-status-bar';
import { CameraType, CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type ClipType = 'talking' | 'broll';
type CaptureState = 'idle' | 'recording' | 'saving';
type UploadState = 'idle' | 'uploading' | 'success' | 'error';

type CapturedClip = {
  uri: string;
  type: ClipType;
  durationSeconds: number;
  createdAt: number;
};

type ReelSummary = {
  id: string;
  name: string;
  path: string;
  hasFacecam: boolean;
  brollCount: number;
};

const REELIFY_API_URL = process.env.EXPO_PUBLIC_REELIFY_API_URL || 'http://localhost:8787';
const MAX_DURATION_SECONDS = 30;

const clipOptions: Array<{ label: string; value: ClipType }> = [
  { label: 'Talking', value: 'talking' },
  { label: 'B-roll', value: 'broll' },
];

export default function App() {
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<CameraType>('front');
  const [clipType, setClipType] = useState<ClipType>('talking');
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [capturedClip, setCapturedClip] = useState<CapturedClip | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [reels, setReels] = useState<ReelSummary[]>([]);
  const [activeReelName, setActiveReelName] = useState('');
  const [reelStatus, setReelStatus] = useState('Loading reels');
  const [reelsLoading, setReelsLoading] = useState(true);
  const [creatingReel, setCreatingReel] = useState(false);

  const permissionsReady = Boolean(cameraPermission && microphonePermission);
  const permissionsGranted = Boolean(cameraPermission?.granted && microphonePermission?.granted);
  const isRecording = captureState === 'recording';
  const isSaving = captureState === 'saving';
  const activeReel = reels.find((reel) => reel.name === activeReelName) || null;

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    const timerId = setInterval(() => {
      setRecordingSeconds((current) => Math.min(current + 1, MAX_DURATION_SECONDS));
    }, 1000);

    return () => clearInterval(timerId);
  }, [isRecording]);

  useEffect(() => {
    loadReels();
  }, []);

  async function requestPermissions() {
    await Promise.all([requestCameraPermission(), requestMicrophonePermission()]);
  }

  async function loadReels() {
    setReelsLoading(true);

    try {
      const nextReels = await fetchReels();
      setReels(nextReels);
      setActiveReelName((current) => {
        if (current && nextReels.some((reel) => reel.name === current)) {
          return current;
        }

        return nextReels[0]?.name || '';
      });
      setReelStatus(nextReels.length > 0 ? 'Reels ready' : 'Create a reel');
    } catch (error) {
      setReelStatus(getErrorMessage(error));
    } finally {
      setReelsLoading(false);
    }
  }

  async function createReel() {
    if (creatingReel || isRecording || isSaving) {
      return;
    }

    setCreatingReel(true);
    setReelStatus('Creating reel');

    try {
      const reel = await createReelOnServer();
      setReels((current) => [reel, ...current.filter((item) => item.name !== reel.name)]);
      setActiveReelName(reel.name);
      setReelStatus(`${reel.name} ready`);
    } catch (error) {
      setReelStatus(getErrorMessage(error));
    } finally {
      setCreatingReel(false);
    }
  }

  function upsertReel(reel: ReelSummary) {
    setReels((current) => {
      const next = [reel, ...current.filter((item) => item.name !== reel.name)];
      return next.sort((left, right) => right.name.localeCompare(left.name));
    });
    setActiveReelName(reel.name);
  }

  async function startRecording() {
    if (!cameraRef.current || !cameraReady || captureState !== 'idle' || !activeReelName) {
      if (!activeReelName) {
        setReelStatus('Create or select a reel');
      }

      return;
    }

    const startedAt = Date.now();
    setStatusMessage('');
    setUploadState('idle');
    setRecordingSeconds(0);
    setCaptureState('recording');

    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_DURATION_SECONDS,
        maxFileSize: 45 * 1024 * 1024,
      });

      if (video?.uri) {
        setCapturedClip({
          uri: video.uri,
          type: clipType,
          durationSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
          createdAt: startedAt,
        });
      }
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
      setUploadState('error');
    } finally {
      setCaptureState('idle');
    }
  }

  function stopRecording() {
    if (captureState !== 'recording') {
      return;
    }

    setCaptureState('saving');
    cameraRef.current?.stopRecording();
  }

  function resetCapture() {
    setCapturedClip(null);
    setStatusMessage('');
    setUploadState('idle');
    setRecordingSeconds(0);
    setCaptureState('idle');
  }

  async function uploadCapturedClip() {
    if (!capturedClip || uploadState === 'uploading') {
      return;
    }

    setUploadState('uploading');
    setStatusMessage(capturedClip.type === 'broll' ? 'Uploading and tagging' : 'Uploading facecam');

    try {
      if (!activeReelName) {
        throw new Error('Create or select a reel first.');
      }

      const uploadResult = await uploadClip(capturedClip, activeReelName);
      if (uploadResult.reel) {
        upsertReel(uploadResult.reel);
      }

      setUploadState('success');
      setStatusMessage(uploadResult.message);
    } catch (error) {
      setUploadState('error');
      setStatusMessage(getErrorMessage(error));
    }
  }

  if (!permissionsReady) {
    return <LoadingScreen />;
  }

  if (!permissionsGranted) {
    return <PermissionScreen onGrantAccess={requestPermissions} />;
  }

  if (capturedClip) {
    return (
      <ReviewScreen
        clip={capturedClip}
        reelName={activeReelName}
        onRetake={resetCapture}
        onUpload={uploadCapturedClip}
        statusMessage={statusMessage}
        uploadState={uploadState}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={cameraFacing}
        mirror={cameraFacing === 'front'}
        mode="video"
        mute={clipType === 'broll'}
        onCameraReady={() => setCameraReady(true)}
        videoBitrate={2_500_000}
        videoQuality="720p"
      />

      <View style={styles.topOverlay}>
        <View style={styles.promptBlock}>
          <Text style={styles.kicker}>{activeReelName || 'No reel selected'}</Text>
          <Text style={styles.promptText}>What are you filming?</Text>
        </View>

        <ReelStrip
          reels={reels}
          activeReelName={activeReelName}
          creatingReel={creatingReel}
          disabled={isRecording || isSaving}
          onCreateReel={createReel}
          onSelectReel={setActiveReelName}
        />

        <View style={styles.segmentedControl} accessibilityRole="tablist">
          {clipOptions.map((option) => {
            const selected = option.value === clipType;

            return (
              <Pressable
                key={option.value}
                accessibilityRole="tab"
                accessibilityState={{ selected, disabled: isRecording || isSaving }}
                disabled={isRecording || isSaving}
                onPress={() => setClipType(option.value)}
                style={[styles.segment, selected && styles.segmentSelected]}
              >
                <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.sideRail}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Flip camera"
          disabled={isRecording || isSaving}
          onPress={() => setCameraFacing((current) => (current === 'front' ? 'back' : 'front'))}
          style={({ pressed }) => [
            styles.roundToolButton,
            pressed && styles.pressed,
            (isRecording || isSaving) && styles.disabled,
          ]}
        >
          <Text style={styles.roundToolButtonText}>Flip</Text>
        </Pressable>
      </View>

      <View style={styles.bottomOverlay}>
        <View style={styles.statusRow}>
          <View style={[styles.recordingDot, isRecording && styles.recordingDotActive]} />
          <Text style={styles.captureStatusText}>
            {isSaving ? 'Saving' : isRecording ? formatDuration(recordingSeconds) : 'Ready'}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
          disabled={!cameraReady || isSaving || !activeReelName}
          onPress={isRecording ? stopRecording : startRecording}
          style={({ pressed }) => [
            styles.recordButton,
            isRecording && styles.recordButtonActive,
            pressed && styles.pressed,
            (!cameraReady || isSaving || !activeReelName) && styles.disabled,
          ]}
        >
          <View style={[styles.recordButtonCore, isRecording && styles.recordButtonCoreActive]} />
        </Pressable>

        <Text style={styles.helperText}>
          {reelsLoading
            ? 'Loading reels'
            : activeReel
              ? `${activeReel.hasFacecam ? 'Facecam set' : 'Need facecam'} / ${activeReel.brollCount} b-roll`
              : reelStatus}
        </Text>
      </View>
    </View>
  );
}

function LoadingScreen() {
  return (
    <View style={styles.centerScreen}>
      <ActivityIndicator color="#f7d94c" />
      <StatusBar style="light" />
    </View>
  );
}

function PermissionScreen({ onGrantAccess }: { onGrantAccess: () => void }) {
  return (
    <View style={styles.centerScreen}>
      <StatusBar style="light" />
      <View style={styles.permissionPanel}>
        <Text style={styles.permissionTitle}>Camera and mic</Text>
        <Text style={styles.permissionCopy}>
          Reelify needs access before recording a clip.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onGrantAccess}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryButtonText}>Grant access</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ReelStrip({
  reels,
  activeReelName,
  creatingReel,
  disabled,
  onCreateReel,
  onSelectReel,
}: {
  reels: ReelSummary[];
  activeReelName: string;
  creatingReel: boolean;
  disabled: boolean;
  onCreateReel: () => void;
  onSelectReel: (reelName: string) => void;
}) {
  return (
    <View style={styles.reelStrip}>
      <Pressable
        accessibilityRole="button"
        disabled={disabled || creatingReel}
        onPress={onCreateReel}
        style={({ pressed }) => [
          styles.newReelButton,
          pressed && styles.pressed,
          (disabled || creatingReel) && styles.disabled,
        ]}
      >
        {creatingReel ? (
          <ActivityIndicator color="#101010" />
        ) : (
          <Text style={styles.newReelButtonText}>New reel</Text>
        )}
      </Pressable>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.reelList}
      >
        {reels.map((reel) => {
          const selected = reel.name === activeReelName;

          return (
            <Pressable
              key={reel.id}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => onSelectReel(reel.name)}
              style={({ pressed }) => [
                styles.reelPill,
                selected && styles.reelPillSelected,
                pressed && styles.pressed,
                disabled && styles.disabled,
              ]}
            >
              <Text style={[styles.reelPillName, selected && styles.reelPillNameSelected]}>
                {reel.name}
              </Text>
              <Text style={[styles.reelPillMeta, selected && styles.reelPillMetaSelected]}>
                {reel.hasFacecam ? 'Facecam' : 'No facecam'} / {reel.brollCount} b-roll
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function ReviewScreen({
  clip,
  reelName,
  onRetake,
  onUpload,
  statusMessage,
  uploadState,
}: {
  clip: CapturedClip;
  reelName: string;
  onRetake: () => void;
  onUpload: () => void;
  statusMessage: string;
  uploadState: UploadState;
}) {
  const player = useVideoPlayer(clip.uri, (videoPlayer) => {
    videoPlayer.loop = false;
    videoPlayer.play();
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const uploadDisabled = uploadState === 'uploading';

  function replayClip() {
    player.currentTime = 0;
    player.play();
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <VideoView
        style={StyleSheet.absoluteFill}
        player={player}
        contentFit="cover"
        nativeControls={false}
      />

      <View style={styles.reviewTopOverlay}>
        <Text style={styles.kicker}>{reelName || 'No reel selected'}</Text>
        <Text style={styles.reviewTitle}>{getClipLabel(clip.type)}</Text>
        <Text style={styles.reviewMeta}>{formatDuration(clip.durationSeconds)}</Text>
      </View>

      <View style={styles.reviewBottomOverlay}>
        {statusMessage ? (
          <View
            style={[
              styles.uploadNotice,
              uploadState === 'success' && styles.uploadNoticeSuccess,
              uploadState === 'error' && styles.uploadNoticeError,
            ]}
          >
            <Text style={styles.uploadNoticeText}>{statusMessage}</Text>
          </View>
        ) : null}

        <View style={styles.reviewControls}>
          <Pressable
            accessibilityRole="button"
            onPress={onRetake}
            disabled={uploadDisabled}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.pressed,
              uploadDisabled && styles.disabled,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Retake</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={replayClip}
            style={({ pressed }) => [styles.replayButton, pressed && styles.pressed]}
          >
            <Text style={styles.replayButtonText}>{isPlaying ? 'Restart' : 'Replay'}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={onUpload}
            disabled={uploadDisabled}
            style={({ pressed }) => [
              styles.primaryButton,
              styles.reviewUploadButton,
              pressed && styles.pressed,
              uploadDisabled && styles.disabled,
            ]}
          >
            {uploadDisabled ? (
              <ActivityIndicator color="#101010" />
            ) : (
              <Text style={styles.primaryButtonText}>Upload</Text>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

async function fetchReels() {
  const response = await expoFetch(`${REELIFY_API_URL}/api/reels`);
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(getUploadError(response.status, responseText));
  }

  const payload = JSON.parse(responseText) as { reels?: ReelSummary[] };
  return payload.reels || [];
}

async function createReelOnServer() {
  const response = await expoFetch(`${REELIFY_API_URL}/api/reels`, {
    method: 'POST',
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(getUploadError(response.status, responseText));
  }

  const payload = JSON.parse(responseText) as { reel?: ReelSummary };
  if (!payload.reel) {
    throw new Error('Server did not return a reel.');
  }

  return payload.reel;
}

async function uploadClip(clip: CapturedClip, reelName: string) {
  const sourceFile = new File(clip.uri);
  const formData = new FormData();

  formData.append('clipType', clip.type);
  formData.append('reelName', reelName);
  formData.append('durationSeconds', String(clip.durationSeconds));
  formData.append('createdAt', String(clip.createdAt));
  formData.append('clip', sourceFile);

  const response = await expoFetch(`${REELIFY_API_URL}/api/clips`, {
    method: 'POST',
    body: formData,
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(getUploadError(response.status, responseText));
  }

  const payload = JSON.parse(responseText) as {
    boxPath?: string;
    clipType?: ClipType;
    reel?: ReelSummary;
    metadata?: { summary?: string; tagging_status?: string };
  };

  if (payload.clipType === 'broll' && payload.metadata?.summary) {
    const tagStatus = payload.metadata.tagging_status === 'complete' ? 'Tagged' : 'Uploaded';
    return {
      message: `${tagStatus}: ${payload.metadata.summary}`,
      reel: payload.reel,
    };
  }

  return {
    message: payload.boxPath ? `Uploaded ${payload.boxPath}` : 'Uploaded',
    reel: payload.reel,
  };
}

function getUploadError(status: number, responseText: string) {
  try {
    const payload = JSON.parse(responseText) as { error?: string; message?: string; code?: string };
    return payload.error || payload.message || payload.code || `Upload failed (${status}).`;
  } catch {
    return responseText || `Upload failed (${status}).`;
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Something went wrong.';
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');

  return `${minutes}:${seconds}`;
}

function getClipLabel(type: ClipType) {
  return type === 'talking' ? 'Talking head' : 'B-roll';
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#050505',
  },
  centerScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#050505',
    padding: 24,
  },
  topOverlay: {
    position: 'absolute',
    top: 54,
    left: 20,
    right: 20,
  },
  promptBlock: {
    marginBottom: 14,
  },
  kicker: {
    color: 'rgba(255, 255, 255, 0.68)',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0,
    marginBottom: 4,
  },
  promptText: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 0,
  },
  reelStrip: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  reelList: {
    gap: 8,
    paddingRight: 12,
  },
  newReelButton: {
    width: 82,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    marginRight: 8,
    backgroundColor: '#f7d94c',
  },
  newReelButtonText: {
    color: '#101010',
    fontSize: 13,
    fontWeight: '900',
  },
  reelPill: {
    minWidth: 118,
    minHeight: 52,
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
    borderWidth: 1,
  },
  reelPillSelected: {
    backgroundColor: '#ffffff',
    borderColor: '#ffffff',
  },
  reelPillName: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
  },
  reelPillNameSelected: {
    color: '#101010',
  },
  reelPillMeta: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 3,
  },
  reelPillMetaSelected: {
    color: '#3a3a3a',
  },
  segmentedControl: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    borderRadius: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.44)',
    borderColor: 'rgba(255, 255, 255, 0.22)',
    borderWidth: 1,
    padding: 4,
  },
  segment: {
    minWidth: 104,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    paddingHorizontal: 16,
  },
  segmentSelected: {
    backgroundColor: '#f7d94c',
  },
  segmentText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0,
  },
  segmentTextSelected: {
    color: '#101010',
  },
  sideRail: {
    position: 'absolute',
    top: 176,
    right: 18,
  },
  roundToolButton: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 27,
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    borderColor: 'rgba(255, 255, 255, 0.2)',
    borderWidth: 1,
  },
  roundToolButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  bottomOverlay: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 38,
    alignItems: 'center',
  },
  statusRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 12,
    marginBottom: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
  },
  recordingDotActive: {
    backgroundColor: '#ff3b30',
  },
  captureStatusText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  recordButton: {
    width: 92,
    height: 92,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 46,
    borderColor: '#ffffff',
    borderWidth: 5,
    backgroundColor: 'rgba(0, 0, 0, 0.18)',
  },
  recordButtonActive: {
    borderColor: '#ff3b30',
  },
  recordButtonCore: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: '#ff3b30',
  },
  recordButtonCoreActive: {
    width: 34,
    height: 34,
    borderRadius: 8,
  },
  helperText: {
    minHeight: 22,
    marginTop: 14,
    color: 'rgba(255, 255, 255, 0.78)',
    fontSize: 14,
    fontWeight: '700',
  },
  permissionPanel: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 8,
    padding: 20,
    backgroundColor: '#151515',
    borderColor: '#2a2a2a',
    borderWidth: 1,
  },
  permissionTitle: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 8,
  },
  permissionCopy: {
    color: '#d7d7d7',
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 20,
  },
  primaryButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 18,
    backgroundColor: '#f7d94c',
  },
  primaryButtonText: {
    color: '#101010',
    fontSize: 16,
    fontWeight: '900',
  },
  secondaryButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderColor: 'rgba(255, 255, 255, 0.22)',
    borderWidth: 1,
  },
  secondaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  replayButton: {
    minHeight: 58,
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 29,
    backgroundColor: '#ffffff',
  },
  replayButtonText: {
    color: '#101010',
    fontSize: 15,
    fontWeight: '900',
  },
  reviewTopOverlay: {
    position: 'absolute',
    top: 54,
    left: 20,
    right: 20,
  },
  reviewTitle: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '900',
  },
  reviewMeta: {
    color: 'rgba(255, 255, 255, 0.78)',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 4,
  },
  reviewBottomOverlay: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 34,
  },
  reviewControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reviewUploadButton: {
    minWidth: 104,
  },
  uploadNotice: {
    minHeight: 42,
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 14,
    marginBottom: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderWidth: 1,
  },
  uploadNoticeSuccess: {
    backgroundColor: 'rgba(30, 140, 78, 0.82)',
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  uploadNoticeError: {
    backgroundColor: 'rgba(179, 45, 45, 0.86)',
    borderColor: 'rgba(255, 255, 255, 0.22)',
  },
  uploadNoticeText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.5,
  },
});
