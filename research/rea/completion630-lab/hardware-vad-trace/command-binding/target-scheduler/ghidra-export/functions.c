/* target_sched_candidate_01115716 @ 01115716 */

int target_sched_candidate_01115716(undefined4 param_1)

{
  return (char)((uint)param_1 >> 0x10) + -0x20;
}



/* target_sched_candidate_01115724 @ 01115724 */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void target_sched_candidate_01115724(void)

{
  undefined1 *puVar1;
  int iVar2;
  int iVar3;
  undefined4 uVar4;
  undefined4 *puVar5;
  int iVar6;
  uint uVar7;
  undefined4 uStack_2c;
  undefined1 *puStack_28;
  undefined4 uStack_24;
  int iStack_20;
  int *piStack_1c;
  undefined4 *puStack_18;
  
  puVar1 = (undefined1 *)target_sched_candidate_01115716();
  piStack_1c = _UNK_0111584c;
  *_UNK_0111584c = *_UNK_0111584c + 1;
  if ((uint)((int)&uStack_2c - _UNK_01115850) < 0x40) {
    uStack_2c = 1;
    puStack_28 = (undefined1 *)&uStack_2c;
    func_0x02101778(3,1,0x10e,_UNK_01115854);
    func_0x0210396c(0);
  }
  iVar2 = func_0x01115312();
  iVar6 = _UNK_01115858;
  puVar5 = (undefined4 *)((int)puVar1 * 0x14 + _UNK_01115858);
  if (puVar5[1] == 0) {
    uStack_2c = 1;
    puVar5 = _UNK_01115868;
    puStack_28 = puVar1;
    func_0x02101778(3,1,0x11c);
    func_0x0210396c(0);
  }
  else {
    (*(code *)(puVar5[1] & 0xfffffffe))(*puVar5);
  }
  puStack_18 = puVar5;
  iStack_20 = func_0x01115a2c(0);
  if (iStack_20 != 0) {
    func_0x01115a18(0);
  }
  iVar6 = iVar6 + (int)puVar1 * 0x14;
  *(int *)(iVar6 + 8) = *(int *)(iVar6 + 8) + 1;
  iVar3 = func_0x01115312();
  uVar7 = iVar3 - iVar2;
  func_0x01095818(*_UNK_0111585c,*_UNK_0111585c >> 0x1f,1000,0);
  func_0x01095818();
  uVar4 = func_0x010959b0();
  iVar2 = func_0x0109579c(uVar4,1000);
  *(int *)(iVar6 + 0x10) = iVar2 + *(int *)(iVar6 + 0x10);
  if (*(uint *)(iVar6 + 0xc) < uVar7) {
    *(uint *)(iVar6 + 0xc) = uVar7;
  }
  if (23999 < uVar7) {
    uStack_24 = func_0x0109579c(uVar7,0x18);
    uStack_2c = 2;
    puStack_28 = puVar1;
    func_0x02101778(3,1,0x134,_UNK_01115864);
  }
  if (iStack_20 != 0) {
    func_0x01115a04(0);
  }
  *piStack_1c = *piStack_1c + -1;
  return;
}



/* target_sched_candidate_01115afe @ 01115afe */

void target_sched_candidate_01115afe(int param_1)

{
  func_0x01115adc(*(undefined4 *)(param_1 + 8));
  return;
}



/* target_sched_candidate_01115b08 @ 01115b08 */

void target_sched_candidate_01115b08(void)

{
  return;
}



/* target_sched_candidate_01115b0c @ 01115b0c */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void target_sched_candidate_01115b0c(int param_1,int param_2)

{
  int iVar1;
  
  if (((*(byte *)(param_2 + 9) & 0x1f) != 0) ||
     (*(int *)(param_2 + 0x20) != (*(byte *)(param_2 + 9) & 0x1f) - 1)) {
    func_0x02101778(3,399,0x90,_UNK_01115b6c,2,param_1,param_2);
    func_0x0210396c(_UNK_01115b70);
  }
  if (*_UNK_01115b68 != 0) {
    iVar1 = func_0x01115312();
    *(int *)(param_1 + 0x94) = *(int *)(param_1 + 0x94) + (iVar1 - *(int *)(param_1 + 0x90));
    *(int *)(param_2 + 0x90) = iVar1;
  }
  return;
}



/* target_sched_candidate_01115c34 @ 01115c34 */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void target_sched_candidate_01115c34(void)

{
  if ((*(ushort *)(*(int *)(_UNK_01115c5c + 8) + 10) < 0x80) &&
     (*(int *)(_UNK_01115c5c + 0x14) != *(int *)(_UNK_01115c5c + 8))) {
    func_0x02124e40();
    *_UNK_01115c60 = 1;
  }
  return;
}



/* target_sched_candidate_01115c64 @ 01115c64 */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void target_sched_candidate_01115c64(undefined4 param_1,undefined4 param_2)

{
  undefined4 *puVar1;
  uint uVar2;
  int iVar3;
  undefined4 *puVar4;
  undefined4 unaff_r5;
  undefined4 unaff_retaddr;
  undefined4 *puVar5;
  
  iVar3 = *(int *)(_UNK_01115d14 + 8);
  puVar4 = (undefined4 *)(iVar3 + 0x44);
  for (uVar2 = 0; uVar2 < 0x1d; uVar2 = uVar2 + 4) {
    *puVar4 = *(undefined4 *)(uVar2 + 0x10);
    puVar4 = puVar4 + 1;
  }
  *(BADSPACEBASE **)(iVar3 + 100) = register0x00000038;
  *(undefined4 *)(iVar3 + 0x68) = unaff_r5;
  *(undefined4 *)(iVar3 + 0x6c) = unaff_r5;
  *(undefined4 *)(iVar3 + 0x70) = 1;
  puVar4 = (undefined4 *)(iVar3 + 0x28);
  for (puVar5 = (undefined4 *)0x0; puVar5 < (undefined4 *)0xd; puVar5 = puVar5 + 1) {
    *puVar4 = *puVar5;
    puVar4 = puVar4 + 1;
  }
  puVar4 = (undefined4 *)(iVar3 + 0x38);
  for (uVar2 = 0; uVar2 < 5; uVar2 = uVar2 + 4) {
    *puVar4 = *(undefined4 *)(uVar2 + 0x30);
    puVar4 = puVar4 + 1;
  }
  *(undefined4 *)(iVar3 + 0x40) = unaff_retaddr;
  target_sched_candidate_01115b08(param_1,param_2);
  target_sched_candidate_01115b0c
            (*(undefined4 *)(_UNK_01115d14 + 8),*(undefined4 *)(_UNK_01115d14 + 0x14));
  *(undefined4 *)(_UNK_01115d14 + 8) = *(undefined4 *)(_UNK_01115d14 + 0x14);
  target_sched_candidate_01115afe();
  if (*(int *)(*(int *)(_UNK_01115d14 + 0x14) + 0xa4) == _UNK_01115d18) {
    *(undefined4 *)(*(int *)(_UNK_01115d14 + 0x14) + 0xa4) = *_UNK_01115d1c;
  }
  iVar3 = *(int *)(_UNK_01115d14 + 8);
  puVar4 = (undefined4 *)(iVar3 + 0x44);
  for (uVar2 = 0; uVar2 < 0x1d; uVar2 = uVar2 + 4) {
    *(undefined4 *)(uVar2 + 0x10) = *puVar4;
    puVar4 = puVar4 + 1;
  }
  puVar4 = (undefined4 *)(iVar3 + 0x28);
  puVar5 = puVar4;
  for (puVar1 = (undefined4 *)0x0; puVar1 < (undefined4 *)0xd; puVar1 = puVar1 + 1) {
    *puVar1 = *puVar4;
    puVar4 = puVar4 + 1;
  }
  puVar5 = puVar5 + 4;
  for (uVar2 = 0; uVar2 < 5; uVar2 = uVar2 + 4) {
    *(undefined4 *)(uVar2 + 0x30) = *puVar5;
    puVar5 = puVar5 + 1;
  }
  return;
}



/* target_sched_candidate_01115d1e @ 01115d1e */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

undefined4 target_sched_candidate_01115d1e(void)

{
  undefined4 *puVar1;
  undefined4 uVar2;
  undefined4 *puVar3;
  undefined4 *puVar4;
  undefined4 unaff_retaddr;
  undefined4 auStack_20 [6];
  undefined4 uStack_8;
  undefined4 uStack_4;
  
  puVar4 = auStack_20;
  puVar3 = auStack_20;
  for (puVar1 = (undefined4 *)0x0; puVar1 < (undefined4 *)0xd; puVar1 = puVar1 + 1) {
    *puVar3 = *puVar1;
    puVar3 = puVar3 + 1;
  }
  uStack_4 = _UNK_01116058;
  uStack_8 = _UNK_01116058;
  if ((byte)((uint)_UNK_01116058 >> 0x10) < 0x20) {
    puVar4 = (undefined4 *)(_UNK_01115d8c + 0x600);
  }
  *(undefined4 **)((int)puVar4 + -8) = auStack_20;
  *(undefined4 *)((int)puVar4 + -4) = unaff_retaddr;
  target_sched_candidate_01115724();
  target_sched_candidate_01115c34();
  puVar3 = *(undefined4 **)((int)puVar4 + -8);
  uVar2 = puVar3[7];
  for (puVar1 = (undefined4 *)0x0; puVar1 < (undefined4 *)0xd; puVar1 = puVar1 + 1) {
    *puVar1 = *puVar3;
    puVar3 = puVar3 + 1;
  }
  return uVar2;
}



/* image_entry @ 0106e26c */

void image_entry(void)

{
  undefined4 uVar1;
  undefined4 *puVar2;
  undefined4 *puVar3;
  
  FUN_0104be82(uRam0106e2a4);
  FUN_0106e244();
  uVar1 = DAT_0106e2ac;
  puVar3 = DAT_0106e2a8 + 0x180;
  puVar2 = DAT_0106e2a8;
  do {
    *puVar2 = uVar1;
    puVar2 = puVar2 + 1;
  } while ((int)puVar2 < (int)puVar3);
  *DAT_0106e2b0 = 0xe0;
  FUN_0106e324();
  stub();
  do {
                    /* WARNING: Do nothing block with infinite loop */
  } while( true );
}



