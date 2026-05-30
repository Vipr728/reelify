// Navigation root for the Reelify iOS app.
// Must be the very first import so gesture-handler installs before RN renders.
import 'react-native-gesture-handler';

import { Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  DarkTheme,
  NavigationContainer,
  type Theme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from './src/lib/theme';
import RecordScreen from './src/screens/RecordScreen';
import LibraryScreen from './src/screens/LibraryScreen';
import MakeReelScreen from './src/screens/MakeReelScreen';

// Root stack: the tab shell + a modal for reel creation.
export type RootStackParamList = {
  Tabs: undefined;
  MakeReel: undefined;
};

// Bottom tabs nested inside the stack.
export type TabsParamList = {
  Record: undefined;
  Library: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabsParamList>();

// Dark theme derived from react-navigation's DarkTheme with Reelify tokens.
const navTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    border: colors.border,
    text: colors.text,
    primary: colors.accent,
  },
};

function TabsNavigator() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false, // screens render their own headers.
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen
        name="Record"
        component={RecordScreen}
        options={{
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>🎬</Text>,
        }}
      />
      <Tabs.Screen
        name="Library"
        component={LibraryScreen}
        options={{
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>📚</Text>,
        }}
      />
    </Tabs.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator>
          <Stack.Screen
            name="Tabs"
            component={TabsNavigator}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="MakeReel"
            component={MakeReelScreen}
            options={{ presentation: 'modal', title: 'Make a reel' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
