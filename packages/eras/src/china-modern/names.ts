import type { Rng } from '@lifegame/core';
import type { Sex } from '@lifegame/schema';

const SURNAMES = [
  '王', '李', '张', '刘', '陈', '杨', '黄', '赵', '吴', '周', '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '高', '罗',
  '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹', '彭', '曾', '肖', '田', '董', '袁', '潘', '于', '蒋', '蔡',
  '余', '杜', '叶', '程', '苏', '魏', '吕', '丁', '任', '沈', '姚', '卢', '姜', '崔', '钟', '谭', '陆', '汪', '范', '金',
];

// 按出生年代切换用字，模拟命名潮流
const MALE_80S = ['伟', '磊', '强', '军', '勇', '涛', '斌', '超', '刚', '鹏', '杰', '波', '辉', '健', '明', '华', '建国', '志强', '文博', '海洋'];
const FEMALE_80S = ['静', '丽', '娟', '艳', '燕', '敏', '芳', '霞', '玲', '婷', '红', '颖', '雪', '慧', '琳', '梅', '秀英', '晓燕', '丽华', '小红'];
const MALE_00S = ['浩然', '子轩', '宇航', '梓豪', '俊杰', '一诺', '沐辰', '奕辰', '梓睿', '昊天', '子墨', '铭泽', '俊熙', '睿', '皓', '辰'];
const FEMALE_00S = ['欣怡', '梓涵', '诗涵', '雨桐', '可欣', '一诺', '梓萱', '若曦', '思涵', '佳怡', '芷晴', '语嫣', '雨萱', '悦', '涵', '萱'];
const MALE_20S = ['沐阳', '安澜', '知远', '星野', '予安', '泽言', '清和', '云舟', '时予', '北辰', '既白', '行简'];
const FEMALE_20S = ['安宁', '知夏', '栀夏', '书意', '清婉', '念初', '予南', '星晚', '觅夏', '清欢', '时安', '简宁'];

export function surname(rng: Rng): string {
  return rng.pick(SURNAMES);
}

export function givenName(rng: Rng, sex: Sex, birthYear: number): string {
  const pool = birthYear < 1995
    ? (sex === 'male' ? MALE_80S : FEMALE_80S)
    : birthYear < 2018
      ? (sex === 'male' ? MALE_00S : FEMALE_00S)
      : (sex === 'male' ? MALE_20S : FEMALE_20S);
  return rng.pick(pool);
}

export function fullName(rng: Rng, sex: Sex, birthYear: number, family?: string): string {
  return (family ?? surname(rng)) + givenName(rng, sex, birthYear);
}
