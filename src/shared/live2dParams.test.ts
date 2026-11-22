import { describe, expect, it } from 'vitest';
import {
  effectiveLive2DParams,
  expressionDoesSomething,
  live2dManifestShape,
  live2dParamsShape,
  readMoc3Parameters,
  resolveLive2DParams,
  resolveLive2DParamsFromFiles,
  type Live2DParamInfo,
} from './live2dParams';
import { fakeMoc3 } from './moc3Fixture';

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

/** The Cubism sample models' standard set (ranges as the SDK samples ship them). */
const STANDARD: Live2DParamInfo[] = [
  { id: 'ParamAngleX', min: -30, max: 30, def: 0 },
  { id: 'ParamAngleY', min: -30, max: 30, def: 0 },
  { id: 'ParamAngleZ', min: -30, max: 30, def: 0 },
  { id: 'ParamEyeLOpen', min: 0, max: 1.2, def: 1 },
  { id: 'ParamEyeLSmile', min: 0, max: 1, def: 0 },
  { id: 'ParamEyeROpen', min: 0, max: 1.2, def: 1 },
  { id: 'ParamEyeRSmile', min: 0, max: 1, def: 0 },
  { id: 'ParamEyeBallX', min: -1, max: 1, def: 0 },
  { id: 'ParamEyeBallY', min: -1, max: 1, def: 0 },
  { id: 'ParamBrowLY', min: -1, max: 1, def: 0 },
  { id: 'ParamMouthForm', min: -1, max: 1, def: 0 },
  { id: 'ParamMouthOpenY', min: 0, max: 1, def: 0 },
  { id: 'ParamBodyAngleX', min: -10, max: 10, def: 0 },
  { id: 'ParamBreath', min: 0, max: 1, def: 0 },
];

describe('readMoc3Parameters', () => {
  it('reads ids and ranges in both byte orders', () => {
    const params = [
      { id: 'ParamEspressioni', min: 0, max: 8, def: 0 },
      { id: 'ParamBocca', min: 0, max: 1, def: 0 },
    ];
    expect(readMoc3Parameters(fakeMoc3(params))).toEqual(params);
    expect(readMoc3Parameters(fakeMoc3(params, { bigEndian: true }))).toEqual(params);
  });

  it('returns null for bytes that are not a moc3 parameter table', () => {
    expect(readMoc3Parameters(new Uint8Array([1, 2, 3]))).toBeNull();
    const bad = fakeMoc3([{ id: 'A' }]);
    bad[0] = 0x58; // not "MOC3"
    expect(readMoc3Parameters(bad)).toBeNull();
    const truncated = fakeMoc3([{ id: 'ParamA' }, { id: 'ParamB' }]).subarray(0, 900);
    expect(readMoc3Parameters(truncated)).toBeNull();
    // min > max: a layout this does not know, not garbage.
    expect(readMoc3Parameters(fakeMoc3([{ id: 'ParamA', min: 2, max: 1, def: 1 }]))).toBeNull();
  });
});

describe('resolveLive2DParams (261122)', () => {
  it('a standard model keeps the standard ids', () => {
    const r = resolveLive2DParams({ params: STANDARD, lipSync: ['ParamMouthOpenY'], eyeBlink: ['ParamEyeLOpen', 'ParamEyeROpen'] });
    expect(r.roles).toEqual({
      mouthOpen: 'ParamMouthOpenY',
      eyeLOpen: 'ParamEyeLOpen',
      eyeROpen: 'ParamEyeROpen',
      eyeBallX: 'ParamEyeBallX',
      eyeBallY: 'ParamEyeBallY',
      angleX: 'ParamAngleX',
      angleY: 'ParamAngleY',
      angleZ: 'ParamAngleZ',
      bodyAngleX: 'ParamBodyAngleX',
      breath: 'ParamBreath',
    });
    expect(r.blink).toEqual(['ParamEyeLOpen', 'ParamEyeROpen']);
    expect(live2dParamsShape(r)).toEqual({ l2d_ids: 'standard', l2d_mouth: true, l2d_blink: true, l2d_gaze: 'eyes_head' });
  });

  it('an Italian model with empty groups: the mouth is ParamBocca ("BoccaAperta"), nothing else is guessed', () => {
    const r = resolveLive2DParams({
      params: [
        { id: 'ParamEspressioni', min: 0, max: 8, def: 0 },
        { id: 'PupCoda', min: -1, max: 1, def: 0 },
        { id: 'ParamHairFront', min: -1, max: 1, def: 0 },
        { id: 'ParamBocca', min: 0, max: 1, def: 0 },
      ],
      names: new Map([
        ['ParamEspressioni', 'Espressioni'],
        ['PupCoda', 'PupCoda'],
        ['ParamHairFront', 'Hair Move Front'],
        ['ParamBocca', 'BoccaAperta'],
      ]),
      lipSync: [],
      eyeBlink: [],
    });
    expect(r.roles).toEqual({ mouthOpen: 'ParamBocca' });
    expect(r.blink).toEqual([]);
    expect(live2dParamsShape(r)).toEqual({ l2d_ids: 'remapped', l2d_mouth: true, l2d_blink: false, l2d_gaze: 'none' });
  });

  it('Cubism 2 style ids (PARAM_EYE_BALL_X) are the standard ones written another way', () => {
    const r = resolveLive2DParams({
      params: [
        { id: 'PARAM_ANGLE_X', min: -30, max: 30, def: 0 },
        { id: 'PARAM_ANGLE_Z', min: -30, max: 30, def: 0 },
        { id: 'PARAM_EYE_L_OPEN', min: 0, max: 1, def: 1 },
        { id: 'PARAM_EYE_R_OPEN', min: 0, max: 1, def: 1 },
        { id: 'PARAM_EYE_BALL_X', min: -1, max: 1, def: 0 },
        { id: 'PARAM_MOUTH_FORM', min: 0, max: 1, def: 0 },
        // A Cubism 2 sample (Wanko) rests its mouth at 1.
        { id: 'PARAM_MOUTH_OPEN_Y', min: 0, max: 1, def: 1 },
      ],
    });
    expect(r.roles.mouthOpen).toBe('PARAM_MOUTH_OPEN_Y');
    expect(r.roles.eyeBallX).toBe('PARAM_EYE_BALL_X');
    expect(r.roles.angleZ).toBe('PARAM_ANGLE_Z');
    expect(r.blink).toEqual(['PARAM_EYE_L_OPEN', 'PARAM_EYE_R_OPEN']);
  });

  it('display names alone are enough (Japanese, German, Spanish)', () => {
    const ja = resolveLive2DParams({
      params: [
        { id: 'P0', name: 'è§’åº¦ X', min: -30, max: 30, def: 0 },
        { id: 'P1', name: 'è§’åº¦ Y', min: -30, max: 30, def: 0 },
        { id: 'P2', name: 'å·¦ç›®ã€€é–‹é–‰', min: 0, max: 1, def: 1 },
        { id: 'P3', name: 'å³ç›®ã€€é–‹é–‰', min: 0, max: 1, def: 1 },
        { id: 'P4', name: 'ç›®çŽ‰ X', min: -1, max: 1, def: 0 },
        { id: 'P5', name: 'ç›®çŽ‰ Y', min: -1, max: 1, def: 0 },
        { id: 'P6', name: 'å£ã€€å¤‰å½¢', min: -1, max: 1, def: 0 },
        { id: 'P7', name: 'å£ã€€é–‹é–‰', min: 0, max: 1, def: 0 },
        { id: 'P8', name: 'ä½“ã®å›žè»¢ã€€X', min: -10, max: 10, def: 0 },
        { id: 'P9', name: 'å‘¼å¸', min: 0, max: 1, def: 0 },
      ],
    });
    expect(ja.roles).toEqual({
      angleX: 'P0',
      angleY: 'P1',
      eyeLOpen: 'P2',
      eyeROpen: 'P3',
      eyeBallX: 'P4',
      eyeBallY: 'P5',
      mouthOpen: 'P7',
      bodyAngleX: 'P8',
      breath: 'P9',
    });
    const de = resolveLive2DParams({
      params: [
        { id: 'KopfX', min: -30, max: 30, def: 0 },
        { id: 'AugeRechtsOffen', min: 0, max: 1, def: 1 },
        { id: 'AugeLinksOffen', min: 0, max: 1, def: 1 },
        { id: 'PupilleX', min: -1, max: 1, def: 0 },
        { id: 'MundOffen', min: 0, max: 1, def: 0 },
      ],
    });
    expect(de.roles).toMatchObject({ angleX: 'KopfX', eyeLOpen: 'AugeLinksOffen', eyeROpen: 'AugeRechtsOffen', eyeBallX: 'PupilleX', mouthOpen: 'MundOffen' });
    const es = resolveLive2DParams({ params: [{ id: 'BocaAbierta' }, { id: 'OjoIzquierdo' }] });
    expect(es.roles.mouthOpen).toBe('BocaAbierta');
  });

  it('never takes a mouth shape for the opening when several mouth parameters exist', () => {
    const r = resolveLive2DParams({
      params: [
        { id: 'ParamMouthUp', name: 'ä¸ŠãŒã‚Šå£', min: 0, max: 1, def: 0 },
        { id: 'ParamMouthDown', name: 'ä¸‹ãŒã‚Šå£', min: 0, max: 1, def: 0 },
        { id: 'ParamMouthForm', min: -1, max: 1, def: 0 },
      ],
    });
    expect(r.roles.mouthOpen).toBeUndefined();
  });

  it('an eye parameter that rests closed (a "close" slider) is never the blink', () => {
    const r = resolveLive2DParams({
      params: [
        { id: 'EyeLClose', min: 0, max: 1, def: 0 },
        { id: 'EyeRClose', min: 0, max: 1, def: 0 },
        { id: 'EyeSmile', min: 0, max: 1, def: 0 },
      ],
    });
    expect(r.blink).toEqual([]);
  });

  it("prefers the author's LipSync group (a vowel parameter) over the standard mouth", () => {
    const r = resolveLive2DParams({ params: [...STANDARD, { id: 'ParamA', min: 0, max: 1, def: 0 }], lipSync: ['ParamA'] });
    expect(r.roles.mouthOpen).toBe('ParamA');
    expect(live2dParamsShape(r).l2d_ids).toBe('remapped');
  });

  it('with no parameter list it keeps the old behaviour (standard ids, standard blink)', () => {
    const r = resolveLive2DParams({ params: null });
    expect(r.source).toBe('none');
    expect(r.roles.mouthOpen).toBe('ParamMouthOpenY');
    expect(r.blink).toEqual(['ParamEyeLOpen', 'ParamEyeROpen']);
    expect(live2dParamsShape(r).l2d_ids).toBe('unknown');
  });
});

describe('resolveLive2DParamsFromFiles', () => {
  it('reads the moc3, the cdi3 names and the groups from the files', () => {
    const files = [
      {
        path: 'm/model.model3.json',
        bytes: enc({
          FileReferences: { Moc: 'model.moc3', DisplayInfo: './model.cdi3.json' },
          Groups: [
            { Target: 'Parameter', Name: 'EyeBlink', Ids: [] },
            { Target: 'Parameter', Name: 'LipSync', Ids: [] },
          ],
        }),
      },
      { path: 'm/model.moc3', bytes: fakeMoc3([{ id: 'ParamX1' }, { id: 'ParamX2', min: 0, max: 1, def: 1 }, { id: 'ParamX3', min: 0, max: 1, def: 1 }]) },
      {
        path: 'm/model.cdi3.json',
        bytes: enc({ Parameters: [{ Id: 'ParamX1', Name: 'Bocca Aperta' }, { Id: 'ParamX2', Name: 'Occhio Sinistro Aperto' }, { Id: 'ParamX3', Name: 'Occhio Destro Aperto' }] }),
      },
    ];
    const r = resolveLive2DParamsFromFiles(files, 'm/model.model3.json');
    expect(r?.source).toBe('moc');
    expect(r?.roles).toEqual({ mouthOpen: 'ParamX1', eyeLOpen: 'ParamX2', eyeROpen: 'ParamX3' });
    expect(r?.blink).toEqual(['ParamX2', 'ParamX3']);
  });

  it('falls back to the cdi3 list when the moc3 does not read', () => {
    const files = [
      { path: 'model.model3.json', bytes: enc({ FileReferences: { Moc: 'model.moc3', DisplayInfo: 'model.cdi3.json' } }) },
      { path: 'model.moc3', bytes: new Uint8Array([1, 2, 3]) },
      { path: 'model.cdi3.json', bytes: enc({ Parameters: [{ Id: 'ParamBocca', Name: 'BoccaAperta' }] }) },
    ];
    const r = resolveLive2DParamsFromFiles(files, 'model.model3.json');
    expect(r?.source).toBe('cdi');
    expect(r?.roles).toEqual({ mouthOpen: 'ParamBocca' });
  });
});

describe('effectiveLive2DParams', () => {
  it('overrides win, null turns a role off, eye overrides rebuild the blink', () => {
    const base = resolveLive2DParams({ params: STANDARD });
    const r = effectiveLive2DParams(base, { mouthOpen: 'ParamCustomMouth', angleZ: null, eyeROpen: null });
    expect(r.roles.mouthOpen).toBe('ParamCustomMouth');
    expect(r.roles.angleZ).toBeUndefined();
    expect(r.blink).toEqual(['ParamEyeLOpen']);
    expect(effectiveLive2DParams(base, undefined)).toBe(base);
  });
});

describe('expressionDoesSomething', () => {
  it('an expression with no parameters, zero adds or unknown ids is a no-op', () => {
    expect(expressionDoesSomething({ Type: 'Live2D Expression', Parameters: [] })).toBe(false);
    expect(expressionDoesSomething({ Type: 'Live2D Expression' })).toBe(false);
    expect(expressionDoesSomething({ Parameters: [{ Id: 'ParamCheek', Value: 0, Blend: 'Add' }] })).toBe(false);
    expect(expressionDoesSomething({ Parameters: [{ Id: 'ParamCheek', Value: 1, Blend: 'Multiply' }] })).toBe(false);
    expect(expressionDoesSomething({ Parameters: [{ Id: 'ParamCheek', Value: 1 }] }, new Set(['ParamOther']))).toBe(false);
    expect(expressionDoesSomething({ Parameters: [{ Id: 'ParamCheek', Value: 1 }] }, new Set(['ParamCheek']))).toBe(true);
    expect(expressionDoesSomething({ Parameters: [{ Id: 'ParamCheek', Value: 0, Blend: 'Overwrite' }] })).toBe(true);
    expect(expressionDoesSomething(null)).toBe(false);
  });
});

describe('live2dManifestShape', () => {
  it('is shape only: no ids or names', () => {
    const shape = live2dManifestShape({
      params: resolveLive2DParams({ params: [{ id: 'ParamBocca', name: 'BoccaAperta' }] }),
      expressions: [],
      unusableExpressions: ['Angry', 'Sad'],
    });
    expect(shape).toEqual({ l2d_ids: 'remapped', l2d_mouth: true, l2d_blink: false, l2d_gaze: 'none', l2d_expr_usable: 0, l2d_expr_noop: 2 });
    expect(JSON.stringify(shape)).not.toMatch(/Bocca|Angry/);
  });
});




