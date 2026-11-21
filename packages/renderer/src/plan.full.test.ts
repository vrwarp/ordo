import { createHash } from 'node:crypto';
import { LOOK_MAIN } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { CLAMP } from './clamp.ts';
import { picture, slideOf, texts } from './frame.test-util.ts';
import { planFrame } from './plan.ts';
import { ordinarySlides, stateOf } from './plan.full.test-util.ts';

/*
 * `SlideDesc.full` (design 29 R1, frame.ts): the slide before the live clamp's cut, set only for a slide the cut
 * changes. Every other field of the descriptor, and the whole descriptor of every ordinary slide, is what the
 * planner made before it existed.
 */

/** Digests of the descriptors the planner made for `ordinarySlides()` on r2b2-base (before the field existed). */
const BASE_DESCRIPTORS = [
  '469fbc2c1e348a0d',
  'cb797d8a111f6f03',
  'ff74f57518584f84',
  'e98a63de94b526a4',
  '578e774c0076a892',
  '3539e7effac4b656',
  'd71b60fcb643003c',
  '947dd886d9ced700',
  '35ccf60bc9f496b5',
  'a6bd3b8d58ce5453',
  '87282a96138394e5',
  'f6fcc34fe99e4937',
  '7f8530573c08e4fc',
  '9523c788ea6fb86f',
  '818c29b93736e520',
  'db2bfc7259fc4004',
  '719cbf2a5d98760c',
  '20f3db92c0708207',
  '17b12eb595c68915',
  '661a5a821989abd1',
  '046cdb96d1dbaf40',
  '7415d5ad4858174f',
  '9b2aaef1f7db1f89',
  'f7d5437a56002143',
  'cc4bdd036502517d',
  '2fc66b70a87804c3',
  '28b13bcac83b386c',
  'e86156a050fa6511',
  '421eb847a3b5be54',
  '63fa8114b602a2e6',
  '9d443c973d3e71c0',
  '00842c5f124784dc',
  '476ae8dd552e192b',
  '55a41b1a1fe125a3',
  'e92a8b6b4f797523',
  '4c4e394c173090bc',
  'c497a8ba96c88e76',
  '0c4dccd0b6111da5',
  '7d15592088f1e553',
  'f8328da26661d5f5',
  'ab71b923ed3333da',
  '1c2767f5d0537876',
  '80fa0e2ad68c10a6',
  '4e0edff9e6414855',
  '9cc7bbd10c3c96cd',
  '346ecb52222fae24',
  '051f863c5bfe7767',
  'aae19ead2acda4f3',
  '808dce48c2674976',
  '1d22c3db574b978c',
  'cc09509282195f2f',
  '18c558f206d2c03f',
  'f44724e69d880526',
  'e31d465425cda961',
  '00fada4bf6d34d21',
  '168730fb31abc20a',
  'dde6002ba353ab80',
  'aac16541f567f95e',
  '816ecba89446c21b',
  '4b61d56e2cbbcbf5',
  'fc34aab2ae01d50e',
  '8d5f3eba78dc0132',
  '5420fdcae9de1567',
  'a93d83707afb79e3',
  'ba92e4fc9faece35',
  '12c9d730d1416881',
  'fa500050dd2dd211',
  'a2bcc2bd8625243f',
  'ac64f822803f32bb',
  'c823db9e962c2fbc',
  '2214b23e3ccc9b8e',
  '56ca409b6e493e98',
  '1b58d91d5773c43e',
  '1fdf93a1b7019829',
  '3cc1aec01b096dea',
  'd557d535b019a56d',
  '83442b573295a512',
  'e6e1a05d5e1c3708',
  '454da04f02f85191',
  'ddf2ff9ebe62643f',
  'ec00e40dfae1d26d',
  'c6b984ded6a82702',
  'c0bbc30693a2d19c',
  '0ba54f459d393b8e',
  'b37faadc4ddbd44e',
  '458ad9e21f2b8d02',
  '5962610899d33bc8',
  '51285f75a4eb065d',
  '36cb84fc0b89ac0d',
  '40448af43fa45187',
  'aa13c354fbc8e3f6',
  '672f2e85f9784d69',
  '0a9e5755ef1b0517',
  '1ce89eb179ec3805',
  'b706655c1f68b32a',
  '2f6a2f2f3e1bf34d',
  'bb7cc898aa2e609e',
  'caf9b1c15dd08c65',
  'c62df5a672b9f8b9',
  '5cd0a874862663e3',
];

describe('SlideDesc.full', () => {
  it("is absent for 100 ordinary slides, whose descriptors equal the base planner's byte for byte", () => {
    const slides = ordinarySlides();
    expect(slides).toHaveLength(BASE_DESCRIPTORS.length);
    slides.forEach((s, i) => {
      const desc = planFrame(stateOf(s), LOOK_MAIN).slide.desc!;
      expect(desc.full, s.id).toBeUndefined();
      expect('full' in desc, s.id).toBe(false);
      const digest = createHash('sha256').update(JSON.stringify(desc)).digest('hex').slice(0, 16);
      expect(digest, s.id).toBe(BASE_DESCRIPTORS[i]);
    });
  });

  it('holds the whole slide when it has more than 200 objects, and slide stays the cut one', () => {
    const s = slideOf(texts(340));
    const desc = planFrame(stateOf(s), LOOK_MAIN).slide.desc!;
    expect(desc.slide.objects).toHaveLength(CLAMP.maxObjects);
    expect(desc.full!.objects).toHaveLength(340);
    expect(desc.full!.objects.slice(0, 200)).toEqual(desc.slide.objects);
  });

  it('holds the whole slide when it has more than 16 distinct pictures', () => {
    const pics = Array.from({ length: 24 }, (_, i) =>
      picture(`p${i}`, `m${i}`, { x: 10 + (i % 8) * 200, y: 10 + Math.floor(i / 8) * 200, w: 180, h: 180 }),
    );
    const desc = planFrame(stateOf(slideOf(pics)), LOOK_MAIN).slide.desc!;
    expect(desc.slide.objects).toHaveLength(16);
    expect(desc.full!.objects).toHaveLength(24);
  });

  it('is absent at exactly 200 objects and exactly 16 pictures, and for entries the clamp drops anyway', () => {
    expect(planFrame(stateOf(slideOf(texts(200))), LOOK_MAIN).slide.desc!.full).toBeUndefined();
    const pics = Array.from({ length: 16 }, (_, i) =>
      picture(`p${i}`, `m${i}`, { x: i * 100, y: 0, w: 90, h: 90 }),
    );
    expect(planFrame(stateOf(slideOf(pics)), LOOK_MAIN).slide.desc!.full).toBeUndefined();
    // 250 entries of which 60 are not objects at all: the clamp keeps 190, so nothing is cut
    const junk = [...texts(190), ...Array.from({ length: 60 }, () => ({ nothing: true }) as never)];
    expect(planFrame(stateOf(slideOf(junk)), LOOK_MAIN).slide.desc!.full).toBeUndefined();
  });

  it('is the same object on a second plan of the same slide (memoised)', () => {
    const state = stateOf(slideOf(texts(300)));
    const a = planFrame(state, LOOK_MAIN).slide.desc!.full;
    expect(a).toBeDefined();
    expect(planFrame(state, LOOK_MAIN).slide.desc!.full).toBe(a);
  });
});
