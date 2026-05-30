// MakeReelScreen: topic entry + (eventually) reel generation.
//
// TODO(P3-P6): wire up real reel generation:
//   - call makeReel(topic) from '../lib/api' (POST /make-reel -> { job_id, edl })
//   - insert/poll render_jobs via supabase until status 'done' | 'failed'
//   - render <VideoView> from expo-video on the returned output_url
// For now this is a real-but-inert screen: topic input + a disabled CTA.
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '../lib/theme';

export default function MakeReelScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const [topic, setTopic] = useState('');

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom },
      ]}
    >
      {/* Back affordance (modal presentation). */}
      <Pressable
        style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        onPress={() => navigation.goBack()}
        hitSlop={8}
      >
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>

      <Text style={styles.title}>Make a reel</Text>

      <TextInput
        style={styles.input}
        value={topic}
        onChangeText={setTopic}
        placeholder="What's this reel about? e.g. building an app solo"
        placeholderTextColor={colors.textMuted}
        multiline
        autoCorrect
      />

      <Pressable disabled style={[styles.cta, styles.ctaDisabled]}>
        <Text style={styles.ctaText}>Make a reel</Text>
      </Pressable>
      <Text style={styles.caption}>
        Reel generation lands in a later phase.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  back: { alignSelf: 'flex-start' },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.7 },

  title: { color: colors.text, fontSize: 28, fontWeight: '700' },

  input: {
    minHeight: 96,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text,
    fontSize: 16,
    textAlignVertical: 'top',
  },

  cta: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  ctaDisabled: { backgroundColor: colors.accentDim, opacity: 0.6 },
  ctaText: { color: colors.text, fontSize: 16, fontWeight: '700' },

  caption: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: -spacing.sm,
  },
});
