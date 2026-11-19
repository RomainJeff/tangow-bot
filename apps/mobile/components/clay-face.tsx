import type { AvatarCrop, CharacterFace, FaceState } from "@tangow/contracts";
import { eyesCentre, eyeVeil, gazeOffsets } from "@tangow/contracts";
import { useMemo, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import { StyleSheet, View } from "react-native";
import Svg, { Image as SvgImage } from "react-native-svg";
import { FACES, poseOf } from "../lib/clay-face";
import type { Frame } from "./clay-face-layers";
import {
  ClosedLid,
  LID_TRAVEL,
  LowerLid,
  Mouth,
  PUPIL_ROOM,
  Pupil,
  place,
  Under,
  UpperLid,
} from "./clay-face-layers";

/**
 * The character's faceless body with its face drawn live on top, framed like the still image.
 * Each layer is clipped by a round view. The face shows once the body has loaded (`onReady`).
 * Decorative: the avatar carries the name.
 */
export function ClayFace({
  face,
  body,
  crop,
  size,
  state,
  onReady,
}: {
  face: CharacterFace;
  body: ImageSourcePropType;
  crop: AvatarCrop;
  size: number;
  state: FaceState;
  onReady: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const pose = useMemo(
    () => poseOf(face, { expression: state.expression, gaze: state.gaze }),
    [face, state.expression, state.gaze],
  );
  const frame: Frame = { crop, k: size / crop.side };
  const { k } = frame;
  const offsets = gazeOffsets(face);
  const centre = eyesCentre(face);
  const head = pose.head;
  const turn = head.rv + head.pe * 0.7;
  const r0 = face.yeux[0]!.r;
  const centreAt = place(frame, centre.x, centre.y, 0);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={size} height={size} viewBox={`${crop.x} ${crop.y} ${crop.side} ${crop.side}`}>
        <SvgImage
          href={body}
          width={1024}
          height={1024}
          onLoad={() => {
            setLoaded(true);
            onReady();
          }}
        />
      </Svg>
      {loaded ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              transformOrigin: [centreAt.left, centreAt.top, 0],
              transform: [
                { translateX: head.dx * r0 * k },
                { translateY: head.dy * r0 * k },
                { rotate: `${turn}deg` },
                { scaleY: head.sy },
              ],
            },
          ]}
        >
          <Under face={face} pose={pose} frame={frame} />
          {face.yeux.map((eye, i) => {
            const { cx, cy, r } = eye;
            const eyePose = pose.eyes[i]!;
            const round = FACES.constantes.debord_paupiere * r;
            const room = PUPIL_ROOM * r * k;
            const closed = 1 - eyeVeil(r, eyePose.o, eyePose.ob);
            return (
              <View key={eye.cote} style={StyleSheet.absoluteFill}>
                <View
                  style={[
                    styles.clip,
                    place(frame, cx - r, cy - r, 2 * r),
                    { borderRadius: r * k },
                  ]}
                >
                  <View style={{ position: "absolute", left: -room, top: -room }}>
                    <Pupil eye={eye} pose={eyePose} offset={offsets[i]!} face={face} k={k} />
                  </View>
                  <View style={StyleSheet.absoluteFill}>
                    <LowerLid eye={eye} pose={eyePose} face={face} k={k} />
                  </View>
                </View>
                <View
                  style={[
                    styles.clip,
                    place(frame, cx - round, cy + 0.05 * r - round, 2 * round),
                    { borderRadius: round * k },
                  ]}
                >
                  <View style={{ position: "absolute", left: 0, top: -LID_TRAVEL * r * k }}>
                    <UpperLid eye={eye} pose={eyePose} face={face} k={k} />
                  </View>
                  {closed > 0.001 ? (
                    <View style={StyleSheet.absoluteFill}>
                      <ClosedLid eye={eye} opacity={closed} k={k} />
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })}
          <Mouth face={face} pose={pose} frame={frame} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { position: "absolute", overflow: "hidden" },
});
