import { motion } from "@rakazo/ui-tokens";
import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { stopContourSweepOpacities } from "../lib/stop-contour-math";

// Enough butting segments that the stepped opacity reads as one smooth glow.
const SEGMENT_COUNT = 96;
const RING_STROKE = 2;

/**
 * The Stop button's edge: the ring IS the disc's
 * border (2 px, at `size`'s outer edge), with two glows in the bot's identity
 * colour chasing each other around it once per `motion.flow`. Reduced motion:
 * a static full ring, no rotation.
 *
 * Draws short butting arcs whose opacity follows the sweep once (see
 * `stopContourSweepOpacities`), then rotates the whole `Svg` — cheaper than
 * recomputing 48 opacities every frame.
 */
export function StopContour({ size, color }: { size: number; color: string }) {
  const reducedMotion = useReducedMotion();
  const rotation = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(rotation);
    if (reducedMotion) {
      rotation.value = 0;
      return;
    }
    rotation.value = withRepeat(
      withTiming(360, { duration: motion.flow, easing: Easing.bezier(0.32, 0.72, 0, 1) }),
      -1,
    );
    return () => cancelAnimation(rotation);
  }, [reducedMotion, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const radius = size / 2 - RING_STROKE / 2;
  const circumference = 2 * Math.PI * radius;
  const segmentLength = circumference / SEGMENT_COUNT;
  const opacities = reducedMotion
    ? Array.from({ length: SEGMENT_COUNT }, () => 1)
    : stopContourSweepOpacities(SEGMENT_COUNT);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        // Centred over the disc by the same Yoga default that centres it
        // (the parent touch target's `alignItems`/`justifyContent: "center"`)
        // rather than by an inset, since the disc and its 44 pt touch target
        // aren't the same size.
        { position: "absolute", width: size, height: size },
        animatedStyle,
      ]}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {opacities.map((opacity, index) => (
          <Circle
            key={index}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeOpacity={opacity}
            strokeWidth={RING_STROKE}
            strokeDasharray={`${segmentLength} ${circumference - segmentLength}`}
            strokeDashoffset={-index * segmentLength}
          />
        ))}
      </Svg>
    </Animated.View>
  );
}
