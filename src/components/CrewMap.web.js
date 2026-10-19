// src/components/CrewMap.web.js
// The native map library has no web build; the map runs in the Android app.
import { Text, View } from 'react-native';

export default function CrewMap() { // props are ignored on web
  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text>The map only runs in the Android app.</Text>
    </View>
  );
}
