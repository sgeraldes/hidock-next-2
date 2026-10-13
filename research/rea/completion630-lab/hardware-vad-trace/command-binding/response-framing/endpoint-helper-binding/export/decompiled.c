/* FUN_0104f520 @ 0104f520 body=[[0104f520, 0104f525]] */

undefined2 FUN_0104f520(void)

{
  return *DAT_0104f528;
}


/* FUN_0104f66c @ 0104f66c body=[[0104f66c, 0104f673]] */

void FUN_0104f66c(void)

{
  FUN_0106a818();
  return;
}


/* FUN_0104f674 @ 0104f674 body=[[0104f674, 0104f67b]] */

void FUN_0104f674(void)

{
  FUN_0106a844();
  return;
}


/* FUN_0106a818 @ 0106a818 body=[[0106a818, 0106a83d]] */

undefined4 FUN_0106a818(void)

{
  undefined4 uVar1;
  undefined4 *puVar2;
  
  puVar2 = (undefined4 *)*DAT_0106a840;
  if (puVar2 == (undefined4 *)0x0) {
LAB_0106a83a:
    uVar1 = 0;
  }
  else {
    if (puVar2[0x118] == 0) {
      uVar1 = *puVar2;
    }
    else {
      if (puVar2[0x119] != 0) goto LAB_0106a83a;
      uVar1 = puVar2[1];
    }
    puVar2[2] = uVar1;
  }
  return uVar1;
}


/* FUN_0106a844 @ 0106a844 body=[[0106a844, 0106a849]] */

undefined4 FUN_0106a844(void)

{
  return 0x2000;
}


