// LibraryScreen: the user's recorded clips with live per-clip status.
// The Box Skill webhook flips clips 'uploaded' -> 'analyzed' server-side; this
// screen polls Supabase to reflect that and supports pull-to-refresh.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { supabase } from '../lib/supabase';
import { POLL_INTERVAL_MS } from '../lib/config';
import { colors, radius, spacing, statusColors } from '../lib/theme';
import type { Clip, ClipStatus } from '../lib/types';

// Statuses that mean analysis is still running on the server.
const IN_PROGRESS: ClipStatus[] = ['uploaded', 'transcribed', 'embedded'];
const isInProgress = (s: ClipStatus) => IN_PROGRESS.includes(s);

// Add a low-opacity alpha to a 6-digit hex for the badge background tint.
function tint(hex: string): string {
  return hex.length === 7 ? `${hex}22` : hex;
}

export default function LibraryScreen() {
  // Loosely-typed nav: Library is nested in Tabs inside the root Stack, so the
  // composite type is painful. navigate('MakeReel') resolves on the parent.
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();

  const [clips, setClips] = useState<Clip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  const fetchClips = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('clips')
      .select('*')
      .order('created_at', { ascending: false });

    if (!mounted.current) return;

    if (err) {
      // Non-fatal: surface a banner, keep the last good data.
      setError(err.message);
      return;
    }
    setError(null);
    setClips((data ?? []) as Clip[]);
  }, []);

  // Initial load + poll loop.
  useEffect(() => {
    mounted.current = true;
    fetchClips();
    const id = setInterval(fetchClips, POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [fetchClips]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchClips();
    if (mounted.current) setRefreshing(false);
  }, [fetchClips]);

  const renderItem = useCallback(({ item }: { item: Clip }) => {
    const color = statusColors[item.status] ?? colors.textMuted;
    const inProgress = isInProgress(item.status);
    const analyzed = item.status === 'analyzed' || item.status === 'ready';

    const topic = item.topic
      ? item.topic
      : analyzed
        ? 'No topic'
        : 'Analyzing…';

    const snippet =
      item.transcript && item.transcript.length > 0
        ? item.transcript.slice(0, 80) +
          (item.transcript.length > 80 ? '…' : '')
        : null;

    return (
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <View style={[styles.badge, { backgroundColor: tint(color) }]}>
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text style={[styles.badgeText, { color }]}>{item.status}</Text>
          </View>
          {inProgress && (
            <ActivityIndicator
              size="small"
              color={colors.textMuted}
              style={styles.badgeSpinner}
            />
          )}
        </View>

        <Text
          style={[styles.topic, !item.topic && styles.topicMuted]}
          numberOfLines={1}
        >
          {topic}
        </Text>

        {snippet && (
          <Text style={styles.snippet} numberOfLines={2}>
            {snippet}
          </Text>
        )}

        <View style={styles.metaRow}>
          <Text style={styles.metaTime}>
            {new Date(item.created_at).toLocaleTimeString()}
          </Text>
          {item.duration_s != null && (
            <Text style={styles.metaDuration}>
              {Math.round(item.duration_s)}s
            </Text>
          )}
          {item.hook_candidate && (
            <View style={styles.chip}>
              <Text style={styles.chipText}>Hook</Text>
            </View>
          )}
          {item.broll_candidate && (
            <View style={styles.chip}>
              <Text style={styles.chipText}>B-roll</Text>
            </View>
          )}
        </View>
      </View>
    );
  }, []);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Library</Text>
        <Pressable
          style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
          onPress={() => navigation.navigate('MakeReel')}
        >
          <Text style={styles.ctaText}>Make a reel</Text>
        </Pressable>
      </View>

      {/* Non-fatal error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText} numberOfLines={2}>
            Couldn’t refresh: {error}
          </Text>
        </View>
      )}

      <FlatList
        data={clips}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        refreshing={refreshing}
        onRefresh={onRefresh}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + spacing.lg },
          clips.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyGlyph}>🎥</Text>
            <Text style={styles.emptyText}>
              No clips yet. Record one to get started.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  cta: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  ctaPressed: { opacity: 0.8 },
  ctaText: { color: colors.text, fontWeight: '600', fontSize: 14 },

  errorBanner: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: `${colors.danger}22`,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 12 },

  listContent: { paddingHorizontal: spacing.md, gap: spacing.sm },
  listEmpty: { flexGrow: 1 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  badgeSpinner: { marginLeft: spacing.xs },

  topic: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginTop: spacing.sm,
  },
  topicMuted: { color: colors.textMuted, fontWeight: '400' },

  snippet: { color: colors.textMuted, fontSize: 13, marginTop: spacing.xs },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  metaTime: { color: colors.textMuted, fontSize: 12 },
  metaDuration: { color: colors.textMuted, fontSize: 12 },
  chip: {
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  chipText: { color: colors.text, fontSize: 11, fontWeight: '600' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  emptyGlyph: { fontSize: 40 },
  emptyText: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
});
