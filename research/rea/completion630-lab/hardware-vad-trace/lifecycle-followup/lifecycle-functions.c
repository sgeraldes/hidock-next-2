/* FUN_01021866 @ 01021866 */

void FUN_01021866(void)

{
  FUN_01021728();
  return;
}



/* FUN_01021168 @ 01021168 */

undefined4 FUN_01021168(void)

{
  int *piVar1;
  undefined4 uVar2;
  
  piVar1 = DAT_010211cc;
  if (*DAT_010211c8 == 0) {
    if (0 < *DAT_010211cc) {
      FUN_0104ba04(PTR_s___s__s__s___s_s__d__dsp_no_init___010211d8,PTR_s_general_010211dc,
                   PTR_s__ERR__010211e0,PTR_s_dsp_dev_config_010211d4,PTR_s__010f8ede_0x1b_010211d0,
                   PTR_s_dsp_dev_config_010211d4,0x20b,PTR_s__010f8ede_0x1b_010211d0);
    }
    uVar2 = 0xffffffff;
  }
  else {
    FUN_01021866(10000,PTR_LAB_010211e4,0);
    if (2 < *piVar1) {
      FUN_0104ba04(PTR_s___s__s__s___sdsp_config__s_010211ec,PTR_s_general_010211dc,
                   PTR_s__INF__010211e8,PTR_s_dsp_dev_config_010211d4,PTR_s__010f8ede_0x1b_010211d0,
                   PTR_s__010f8ede_0x1b_010211d0);
    }
    uVar2 = 0;
  }
  return uVar2;
}



/* FUN_0102267c @ 0102267c */

undefined4 FUN_0102267c(uint param_1)

{
  undefined4 uVar1;
  int iVar2;
  
  if (param_1 - 1 < 0x10) {
    uVar1 = func_0x00000b38();
    return uVar1;
  }
  if (*(ushort *)(*DAT_01022724 + 0x12) == param_1) {
    iVar2 = FUN_010218ec(PTR_LAB_01022728);
    if (iVar2 != 0) {
      FUN_01021870(PTR_LAB_01022728);
    }
    FUN_01021866(300,PTR_LAB_01022728,0);
  }
  return 0;
}



/* FUN_010257cc @ 010257cc */

undefined4 FUN_010257cc(void)

{
  byte bVar1;
  int *piVar2;
  int *piVar3;
  uint uVar4;
  uint uVar5;
  char cVar6;
  int iVar7;
  
  piVar2 = DAT_010258b4;
  iVar7 = *DAT_010258b4;
  if (iVar7 == 0) {
    return 0xffffffff;
  }
  cVar6 = *(char *)(iVar7 + 7);
  if (cVar6 == '\0') {
    return 0;
  }
  if (cVar6 == '\x01') {
    *(undefined1 *)(iVar7 + 7) = 2;
    return 0;
  }
  if (cVar6 != '\x02') {
    return 0;
  }
  uVar4 = FUN_01005540(2);
  uVar5 = FUN_01005540(5);
  piVar3 = DAT_010258b8;
  iVar7 = *piVar2;
  if (*(char *)(iVar7 + 8) == '\x01') {
    if (*DAT_010258b8 != 0) {
      if ((*DAT_010258b8 == 1) &&
         ((uVar4 != *(byte *)(iVar7 + 0xb) || (uVar5 != *(byte *)(iVar7 + 0xc))))) {
        *(char *)(iVar7 + 0xb) = (char)uVar4;
        *(char *)(iVar7 + 0xc) = (char)uVar5;
        iVar7 = FUN_010218ec(PTR_LAB_010258bc);
        if (iVar7 != 0) {
          FUN_01021870(PTR_LAB_010258bc);
        }
        FUN_01021866(5000,PTR_LAB_010258bc,0);
      }
      goto LAB_01025866;
    }
    *(char *)(iVar7 + 9) = (char)uVar4;
    *(char *)(iVar7 + 10) = (char)uVar5;
    if (uVar4 != *(byte *)(iVar7 + 0xb)) {
      FUN_01005548(2,*(byte *)(iVar7 + 0xb) + 2);
    }
    if (uVar5 != *(byte *)(*piVar2 + 0xc)) {
      FUN_01005548(5,*(byte *)(*piVar2 + 0xc) + 2);
    }
    iVar7 = 1;
  }
  else {
    if ((*(char *)(iVar7 + 8) != '\0') || (*DAT_010258b8 != 1)) goto LAB_01025866;
    if (uVar4 != *(byte *)(iVar7 + 9)) {
      FUN_01005548(2,*(byte *)(iVar7 + 9) + 2);
    }
    if (uVar5 != *(byte *)(*piVar2 + 10)) {
      FUN_01005548(5,*(byte *)(*piVar2 + 10) + 2);
    }
    iVar7 = 0;
  }
  *piVar3 = iVar7;
LAB_01025866:
  bVar1 = *(byte *)(*piVar2 + 6);
  if (bVar1 != 0) {
    if (bVar1 < 0x32) {
      cVar6 = bVar1 + 1;
    }
    else {
      cVar6 = '\0';
    }
    *(char *)(*piVar2 + 6) = cVar6;
  }
  return 0;
}



/* FUN_01032a14 @ 01032a14 */

void FUN_01032a14(int param_1)

{
  int *piVar1;
  int iVar2;
  undefined4 uStack_20;
  undefined4 uStack_1c;
  undefined4 auStack_18 [4];
  
  if (*(byte *)(param_1 + 2) < 10) {
    func_0x00000b4c();
    uStack_20 = 1;
    FUN_01030200(3,&uStack_20,uRam01032d64);
    piVar1 = DAT_01032be0;
    if (2 < *DAT_01032be0) {
      FUN_0104ba04(PTR_s___s__s__s___s_detect__headset_we_01032bf0,PTR_s_general_01032bec,
                   PTR_s__INF__01032be8,PTR_s_headset_dev_state_msg_proc_01032bf4,
                   PTR_s__010f8ede_0x1b_01032be4,PTR_s__010f8ede_0x1b_01032be4);
    }
    uStack_1c = 2;
    FUN_010214a4(2,&uStack_1c);
    auStack_18[0] = 1;
    iVar2 = FUN_01026f9c(8,auStack_18);
    if ((iVar2 != 0) && (0 < *piVar1)) {
      FUN_0104ba04(PTR_s___s__s__s___samp_spekaer_enable_f_01032bfc,PTR_s_general_01032bec,
                   PTR_s__ERR__01032bf8,PTR_s_headset_dev_state_msg_proc_01032bf4,
                   PTR_s__010f8ede_0x1b_01032be4,PTR_s__010f8ede_0x1b_01032be4);
    }
    FUN_01021866(100,PTR_LAB_01032c00,0);
    FUN_01021866(2000,PTR_LAB_01032c04,0);
  }
  else if (0 < *DAT_01032d28) {
    FUN_0104ba04(PTR_s___s__s__s___sMSG_HAEDSET_ERROR_s_01032d44,PTR_s_general_01032d1c,
                 PTR_s__ERR__01032d38,PTR_s_headset_dev_state_msg_proc_01032d24,
                 PTR_s__010f8ede_0x1b_01032d14,PTR_s__010f8ede_0x1b_01032d14);
  }
  return;
}



/* FUN_01021920 @ 01021920 */

void FUN_01021920(int param_1)

{
  int *piVar1;
  undefined *puVar2;
  int iVar3;
  undefined4 uVar4;
  byte bVar5;
  byte *pbVar6;
  undefined1 uVar7;
  bool bVar8;
  char cStack_12;
  char cStack_11;
  char cStack_10;
  byte bStack_f;
  byte bStack_e;
  byte bStack_d;
  
  cStack_12 = '\0';
  FUN_01023f00(0xd,&cStack_12);
  piVar1 = DAT_01021b10;
  bVar5 = *(byte *)(param_1 + 2);
  if (cStack_12 != '\0') {
    if (bVar5 == 0xda) {
      cStack_12 = '\x03';
    }
    else if (bVar5 < 0xdb) {
      if (bVar5 == 0xd8) {
        cStack_12 = '\x04';
      }
      else if (bVar5 < 0xd9) {
        if (bVar5 != 0x8b) {
          return;
        }
        cStack_12 = '\x02';
      }
      else {
        cStack_12 = '\x01';
      }
    }
    else if (bVar5 == 0xdd) {
      cStack_12 = '\a';
    }
    else if (bVar5 == 0xe0) {
      cStack_12 = '\x05';
    }
    else {
      if (bVar5 != 0xdc) {
        return;
      }
      cStack_12 = '\x06';
    }
    FUN_0105b6a0(&cStack_12);
    return;
  }
  if (2 < *DAT_01021b10) {
    FUN_0104ba04(PTR_s___s__s__s___s_sugr_msg_proc__inp_01021b1c,PTR_s_general_01021b18,
                 PTR_s__INF__01021b24,PTR_s_uac_input_event_msg_proc_01021b20,
                 PTR_s__010f8ede_0x1b_01021b14,bVar5,PTR_s__010f8ede_0x1b_01021b14);
  }
  bVar5 = *(byte *)(param_1 + 2);
  if (bVar5 < 0x8e) {
    if (bVar5 < 0x8c) {
      if (0x84 < bVar5) {
        if (bVar5 == 0x88) {
          uVar7 = 0x55;
          bStack_d = 1;
          pbVar6 = &bStack_d;
        }
        else if (bVar5 < 0x89) {
          if (bVar5 != 0x87) goto LAB_010219fc;
          if (*DAT_01021b30 == '\0') {
            *DAT_01021b30 = '\x01';
            bStack_d = 3;
          }
          else {
            *DAT_01021b30 = '\0';
            bStack_d = 2;
          }
          FUN_0105dbec(PTR_s_sugr_app_01021c84,0,0x5f,&bStack_d,1);
          uVar7 = 0x60;
          pbVar6 = &bStack_d;
        }
        else if (bVar5 == 0x8a) {
          if (2 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___s_sugr_msg_proc__inp_01021c94,PTR_s_general_01021c90,
                         PTR_s__INF__01021c8c,PTR_s_uac_input_event_msg_proc_01021c98,
                         PTR_s__010f8ede_0x1b_01021c88,PTR_s__010f8ede_0x1b_01021c88);
          }
          cStack_11 = '\0';
          cStack_10 = '\0';
          bStack_f = 0;
          FUN_0102d828(10,&cStack_11);
          FUN_0102d828(0x10,&cStack_10);
          if (cStack_11 == '\0') {
            iVar3 = FUN_0102d060(1,0);
            if (iVar3 != 0) {
              uVar7 = 0x54;
              bStack_f = 1;
              pbVar6 = &bStack_f;
              goto LAB_01021b54;
            }
            if (cStack_10 != '\0') {
              bStack_e = 7;
              FUN_010214a4(2,&bStack_e);
              FUN_0105dbec(PTR_DAT_01021c9c,4,0x8f,0,0);
              bStack_d = 0;
              FUN_010302cc(1,&bStack_d);
              if (2 < bStack_d) {
                FUN_01021866(0x6e,PTR_LAB_01021ca0,0);
              }
            }
            bStack_f = 1;
          }
          else {
            FUN_0102d060(2,0);
            if (cStack_10 != '\0') {
              bStack_e = 7;
              FUN_010214a4(2,&bStack_e);
              FUN_0105dbec(PTR_DAT_01021c9c,5,0x8f,0,0);
              bStack_d = 0;
              FUN_010302cc(1,&bStack_d);
              if (2 < bStack_d) {
                FUN_01021866(0x6e,PTR_LAB_01021ca0,0);
              }
            }
            bStack_f = 0;
          }
          uVar7 = 0x5d;
          pbVar6 = &bStack_f;
        }
        else {
          if (bVar5 != 0x8b) goto LAB_010219fc;
          bStack_e = 0;
          bStack_d = 1;
          FUN_0102d828(10,&bStack_e);
          if (bStack_e == 0) {
            return;
          }
          iVar3 = FUN_0102d060(3,0);
          if (iVar3 != 0) {
            return;
          }
          uVar7 = 0x5c;
          bStack_d = 1;
          pbVar6 = &bStack_d;
        }
LAB_01021b54:
        uVar4 = 1;
        bVar5 = 0;
        puVar2 = PTR_s_sugr_app_01021c84;
        goto LAB_010219e4;
      }
      if ((bVar5 < 0x83) && (bVar5 != 2)) {
        bVar8 = bVar5 != 0x12;
LAB_010219da:
        if (bVar8) {
LAB_010219fc:
          if (*piVar1 < 3) {
            return;
          }
          FUN_0104ba04(PTR_s___s__s__s___s_sugr_msg_proc__inp_01021b2c,PTR_s_general_01021b18,
                       PTR_s__INF__01021b24,PTR_s_uac_input_event_msg_proc_01021b20,
                       PTR_s__010f8ede_0x1b_01021b14,PTR_s__010f8ede_0x1b_01021b14);
          return;
        }
      }
    }
    uVar7 = *(undefined1 *)(param_1 + 1);
LAB_010219e2:
    uVar4 = 0;
    pbVar6 = (byte *)0x0;
    puVar2 = PTR_DAT_01021b28;
LAB_010219e4:
    FUN_0105dbec(puVar2,bVar5,uVar7,pbVar6,uVar4);
    return;
  }
  if (bVar5 == 0xda) {
    bStack_e = 4;
    bStack_d = 0;
    FUN_0102535c(0xb,&bStack_d);
    if (bStack_d == 2) {
      bStack_e = bStack_d;
    }
    pbVar6 = &bStack_e;
  }
  else {
    if (0xda < bVar5) {
      if (bVar5 < 0xe0) {
        if (0xdd < bVar5) {
          return;
        }
        if (bVar5 == 0xdc) {
          pbVar6 = (byte *)0x0;
          uVar4 = 3;
        }
        else {
          if (bVar5 != 0xdd) goto LAB_010219fc;
          pbVar6 = (byte *)0x0;
          uVar4 = 4;
        }
        goto LAB_01021ac2;
      }
      if (bVar5 == 0xe0) {
        pbVar6 = (byte *)0x0;
        uVar4 = 5;
        goto LAB_01021ac2;
      }
      goto LAB_010219fc;
    }
    if (bVar5 == 0xc5) {
      uVar7 = *(undefined1 *)(param_1 + 1);
      bVar5 = 0xc5;
      goto LAB_010219e2;
    }
    if (bVar5 < 0xc6) {
      bVar8 = bVar5 != 0xa5;
      goto LAB_010219da;
    }
    if (bVar5 == 0xd8) {
      pbVar6 = (byte *)0x0;
      uVar4 = 2;
      goto LAB_01021ac2;
    }
    if (bVar5 != 0xd9) goto LAB_010219fc;
    pbVar6 = &bStack_d;
    bStack_d = 1;
  }
  uVar4 = 7;
LAB_01021ac2:
  FUN_01022c88(uVar4,pbVar6);
  return;
}



/* FUN_01034db8 @ 01034db8 */

void FUN_01034db8(undefined4 param_1,undefined4 param_2,undefined4 param_3,undefined4 param_4,
                 undefined4 param_5,undefined4 param_6)

{
  undefined4 *puVar1;
  undefined *puVar2;
  
  if (2 < *DAT_01034e10) {
    FUN_0104ba04(PTR_s___s__s__s___smsg_id__d_type_id___01034e14,PTR_s_general_01034e20,
                 PTR_s__INF__01034e1c,PTR_s_MessageSendLater_01034e24,PTR_s__010f8ede_0x1b_01034e18,
                 param_2,param_3,param_5,param_6,PTR_s__010f8ede_0x1b_01034e18);
  }
  puVar2 = PTR_LAB_01034e2c;
  puVar1 = DAT_01034e28;
  DAT_01034e28[2] = param_4;
  puVar1[3] = param_5;
  *puVar1 = param_1;
  *(char *)((int)puVar1 + 5) = (char)param_2;
  *(char *)(puVar1 + 1) = (char)param_3;
  FUN_01021866(param_6,puVar2,0);
  return;
}



/* FUN_0101faf4 @ 0101faf4 */

int FUN_0101faf4(void)

{
  int iVar1;
  
  iVar1 = FUN_0102041c();
  if (iVar1 != 0) {
    FUN_010201d8(2,PTR_s_GetApplicationVersionStr__Read_f_0101fb0c);
  }
  return iVar1;
}



/* FUN_0106c368 @ 0106c368 */

void FUN_0106c368(undefined1 param_1,undefined4 param_2,undefined4 param_3,undefined1 param_4,
                 char *param_5,uint param_6)

{
  undefined4 uVar1;
  char cVar2;
  undefined1 uVar3;
  undefined1 uVar4;
  undefined1 uVar5;
  int iVar6;
  char *pcVar7;
  int iVar8;
  undefined1 local_9c;
  undefined1 uStack_94;
  undefined2 uStack_90;
  char local_7c [12];
  undefined2 uStack_70;
  undefined2 uStack_6e;
  undefined1 uStack_6c;
  char cStack_6b;
  undefined1 uStack_68;
  undefined1 uStack_67;
  undefined1 uStack_66;
  undefined1 uStack_65;
  undefined1 uStack_64;
  undefined1 uStack_63;
  undefined1 uStack_62;
  undefined1 uStack_61;
  undefined1 uStack_60;
  undefined1 uStack_5f;
  undefined1 uStack_5e;
  undefined1 uStack_5d;
  undefined1 uStack_5c;
  undefined1 uStack_5b;
  undefined1 uStack_5a;
  undefined1 uStack_59;
  undefined1 uStack_58;
  char cStack_57;
  undefined1 auStack_56 [66];
  
  local_7c[0] = '\x10';
  if (0x40 < param_6) {
    param_6 = 0x40;
  }
  local_7c[1] = 1;
  uStack_94 = (undefined1)param_6;
  local_7c[2] = uStack_94;
  iVar8 = *DAT_0106c4d8;
  *DAT_0106c4d8 = iVar8 + 1;
  uVar3 = (undefined1)((uint)iVar8 >> 8);
  uVar4 = (undefined1)((uint)iVar8 >> 0x10);
  uVar5 = (undefined1)((uint)iVar8 >> 0x18);
  local_7c[3] = (char)iVar8;
  local_7c[4] = uVar3;
  local_7c[5] = uVar4;
  local_7c[6] = uVar5;
  uVar1 = FUN_01090054();
  uStack_5e = (undefined1)uVar1;
  local_7c[7] = uStack_5e;
  uStack_5f = (undefined1)((uint)uVar1 >> 8);
  local_7c[8] = uStack_5f;
  uStack_60 = (undefined1)((uint)uVar1 >> 0x10);
  local_7c[9] = uStack_60;
  uStack_70 = (short)param_2;
  uStack_61 = (undefined1)((uint)uVar1 >> 0x18);
  local_7c[10] = uStack_61;
  local_7c[0xb] = param_1;
  uStack_5a = (undefined1)((uint)param_3 >> 8);
  uStack_90 = (undefined2)param_3;
  uStack_6e = uStack_90;
  uStack_6c = param_4;
  if (param_6 == 0) {
    iVar6 = 0;
    cStack_6b = '\0';
    do {
      pcVar7 = local_7c + iVar6;
      iVar6 = iVar6 + 1;
      cStack_6b = cStack_6b + *pcVar7;
    } while (iVar6 != 0x11);
  }
  else {
    iVar6 = 0;
    cStack_6b = '\0';
    do {
      pcVar7 = local_7c + iVar6;
      iVar6 = iVar6 + 1;
      cStack_6b = cStack_6b + *pcVar7;
    } while (iVar6 != 0x11);
    cVar2 = '\0';
    pcVar7 = param_5;
    do {
      cVar2 = cVar2 + *pcVar7;
      pcVar7 = pcVar7 + 1;
    } while (param_5 + param_6 != pcVar7);
    cStack_6b = cStack_6b + cVar2;
  }
  uStack_68 = 0x10;
  uStack_67 = 1;
  uStack_66 = uStack_94;
  uStack_5b = (undefined1)param_2;
  uStack_5c = (undefined1)((uint)param_2 >> 8);
  local_9c = (undefined1)param_3;
  uStack_59 = local_9c;
  cStack_57 = cStack_6b;
  uStack_65 = uVar5;
  uStack_64 = uVar4;
  uStack_63 = uVar3;
  uStack_62 = (char)iVar8;
  uStack_5d = param_1;
  uStack_58 = param_4;
  func_0x000800aa(auStack_56,param_5,param_6);
  FUN_0105de80(&uStack_68,param_6 + 0x12);
  return;
}



/* FUN_010747e4 @ 010747e4 */

void FUN_010747e4(int param_1,undefined4 param_2,undefined4 param_3)

{
  undefined *puVar1;
  int *piVar2;
  undefined4 uVar3;
  uint uVar4;
  int iVar5;
  
  iVar5 = *(int *)(param_1 + 0x3c);
  if (iVar5 != 0) {
    if (*(char *)(iVar5 + 3) != '\0') {
      return;
    }
    if ((*(byte *)(iVar5 + 0xe8) & 3) != 0) {
      return;
    }
  }
  if ((*(byte *)(param_1 + 0x44) & 1) != 0) {
    uVar3 = FUN_01090054();
    uVar4 = FUN_0105e1fc(uVar3,*(undefined4 *)(param_1 + 0x40));
    if (uVar4 < 8000) {
      iVar5 = *DAT_010748f4;
      puVar1 = PTR_s_a2dp_linking_010fd7d8_7_010748fc;
      goto joined_r0x01074856;
    }
  }
  if ((*(int *)(param_1 + 0x3c) == 0) || (*(int *)(*(int *)(param_1 + 0x3c) + 0x24) == 0)) {
    iVar5 = FUN_01079e38(param_1);
    if (iVar5 == 1) {
      return;
    }
    uVar3 = FUN_01090054();
    piVar2 = DAT_010748f4;
    *(undefined4 *)(param_1 + 0x40) = uVar3;
    if (2 < *piVar2) {
      FUN_0108dd8c(PTR_s_<BT_I>_01074900,0,0,PTR_s_a2dp_connect__01074908,1,PTR_DAT_010748f8,param_2
                  );
    }
    if ((*(int *)(param_1 + 0x3c) == 0) || ((*(byte *)(param_1 + 0x44) & 0x38) == 0)) {
      *(byte *)(param_1 + 0x44) = *(byte *)(param_1 + 0x44) & 199 | 8;
    }
    if ((*(byte *)(param_1 + 0x37) & 0xf0) == 0x10) {
      *(byte *)(param_1 + 0x44) = *(byte *)(param_1 + 0x44) | 2;
    }
    if ((*(byte *)(param_1 + 0x37) & 8) == 0) {
      FUN_0107bf2c(param_3,param_2,param_1);
    }
    else {
      FUN_0107bef4();
    }
    *(byte *)(param_1 + 0x44) = *(byte *)(param_1 + 0x44) | 1;
    return;
  }
  iVar5 = *DAT_010748f4;
  puVar1 = PTR_s_remote_a2dp_linking_01074904;
joined_r0x01074856:
  if (2 < iVar5) {
    FUN_0108dd8c(PTR_s_<BT_I>_01074900,0,0,puVar1,0,PTR_DAT_010748f8);
  }
  return;
}



/* FUN_0107ca2c @ 0107ca2c */

void FUN_0107ca2c(void)

{
  int iVar1;
  undefined4 uVar2;
  
  iVar1 = FUN_010785bc();
  if (iVar1 != 0) {
    uVar2 = FUN_01090054();
    *(undefined4 *)(iVar1 + 0x40) = uVar2;
  }
  return;
}



/* FUN_01080018 @ 01080018 */

void FUN_01080018(int param_1)

{
  undefined *puVar1;
  int *piVar2;
  undefined4 uVar3;
  uint uVar4;
  int iVar5;
  
  piVar2 = DAT_010800f8;
  iVar5 = *(int *)(param_1 + 0x3c);
  if (iVar5 != 0) {
    if (*(char *)(iVar5 + 5) != '\0') {
      return;
    }
    if ((*(byte *)(iVar5 + 0xe8) & 3) != 0) {
      return;
    }
  }
  if ((*(byte *)(param_1 + 0x44) & 1) != 0) {
    uVar3 = FUN_01090054();
    uVar4 = FUN_0105e1fc(uVar3,*(undefined4 *)(param_1 + 0x40));
    if (uVar4 < 8000) {
      iVar5 = *piVar2;
      puVar1 = PTR_s_hfp_linking_010fee1a_7_01080100;
      goto joined_r0x01080084;
    }
  }
  if ((*(int *)(param_1 + 0x3c) == 0) || (*(int *)(*(int *)(param_1 + 0x3c) + 0x5c) == 0)) {
    uVar3 = FUN_01090054();
    iVar5 = *piVar2;
    *(undefined4 *)(param_1 + 0x40) = uVar3;
    if (2 < iVar5) {
      FUN_0108dd8c(PTR_s_<BT_I>_01080104,0,0,PTR_s_hfp_connect_0108010c,0,PTR_DAT_010800fc);
    }
    if (*(int *)(param_1 + 0x3c) == 0) {
      *(byte *)(param_1 + 0x44) = *(byte *)(param_1 + 0x44) & 199 | 8;
    }
    if ((*(byte *)(param_1 + 0x37) & 0xf0) == 0x10) {
      *(byte *)(param_1 + 0x44) = *(byte *)(param_1 + 0x44) | 2;
    }
    FUN_0107e1bc(param_1);
    *(byte *)(param_1 + 0x44) = *(byte *)(param_1 + 0x44) | 1;
    return;
  }
  iVar5 = *piVar2;
  puVar1 = PTR_s_remote_hfp_linking_01080108;
joined_r0x01080084:
  if (2 < iVar5) {
    FUN_0108dd8c(PTR_s_<BT_I>_01080104,0,0,puVar1,0,PTR_DAT_010800fc);
  }
  return;
}



/* FUN_01090848 @ 01090848 */

void FUN_01090848(int param_1,undefined4 param_2,undefined4 param_3)

{
  undefined4 uVar1;
  undefined4 uVar2;
  int iVar3;
  
  if (((param_1 != 0) && (*(int *)(param_1 + 0x18) != 0)) ||
     (FUN_0105df80(PTR_s__ttimer______void___0_______ttim_010908bc,0x8b,
                   PTR_s__010f8ede_0x1b_010908b8), param_1 != 0)) {
    iVar3 = DAT_010908b4;
    if ((*(int *)(param_1 + 0x14) != 0) && (*(int *)(param_1 + 0x14) != *(int *)(DAT_010908b4 + 8)))
    {
      uVar1 = FUN_0108f99c();
      uVar2 = FUN_0108f99c(*(undefined4 *)(iVar3 + 8));
      FUN_0104ba04(PTR_s_thread_timer_init__d_call__d___p_010908c0,uVar1,uVar2,
                   *(undefined4 *)(param_1 + 0x14),*(undefined4 *)(iVar3 + 8),param_1);
    }
    iVar3 = *(int *)(iVar3 + 8);
    uVar1 = FUN_01090054();
    FUN_0108d702(iVar3 + 0x98,param_1,param_2,param_3,uVar1);
  }
  return;
}



/* FUN_0105be78 @ 0105be78 */

void FUN_0105be78(int param_1)

{
  int *piVar1;
  int *piVar2;
  undefined1 uVar3;
  undefined4 uVar4;
  int iVar5;
  uint uVar6;
  int iVar7;
  
  piVar2 = DAT_0105bf70;
  piVar1 = DAT_0105bf58;
  if (param_1 == 0) {
    if (1 < *DAT_0105bf58) {
      FUN_0104ba04(PTR_s___s__s__s___sno_player__s_0105bf68,PTR_s_general_0105bf64,
                   PTR_s__WRN__0105bf60,PTR_s_media_player_fadeout_process_0105bf6c,
                   PTR_s__010f8ede_0x1b_0105bf5c,PTR_s__010f8ede_0x1b_0105bf5c);
    }
  }
  else {
    if (2 < *DAT_0105bf58) {
      uVar4 = FUN_01090054();
      FUN_0104ba04(PTR_s___s__s__s___s_d__p__p_s_0105bf78,PTR_s_general_0105bf64,
                   PTR_s__INF__0105bf74,PTR_s_media_player_fadeout_process_0105bf6c,
                   PTR_s__010f8ede_0x1b_0105bf5c,uVar4,*piVar2,param_1,PTR_s__010f8ede_0x1b_0105bf5c
                  );
    }
    if (param_1 == *piVar2) {
      iVar7 = 0xf;
      FUN_0105bdd8(param_1,2,0xf);
      do {
        iVar7 = iVar7 + -1;
        FUN_0108fad8(1);
        iVar5 = FUN_0105bd30(param_1);
        if (iVar5 != 1) {
          if (iVar7 != 0) goto LAB_0105bf0a;
          break;
        }
      } while (iVar7 != 0);
      if (0 < *piVar1) {
        FUN_0104ba04(PTR_s___s__s__s___swait_fade_timeout___0105bf80,PTR_s_general_0105bf64,
                     PTR_s__ERR__0105bf7c,PTR_s_media_player_fadeout_process_0105bf6c,
                     PTR_s__010f8ede_0x1b_0105bf5c,PTR_s__010f8ede_0x1b_0105bf5c);
      }
    }
LAB_0105bf0a:
    uVar3 = FUN_01052740();
    uVar6 = FUN_010523c0(uVar3);
    if ((uVar6 & 8) == 0) {
      iVar7 = FUN_01051f38(uVar3);
      if (iVar7 == 3) {
        uVar4 = 10;
      }
      else {
        iVar7 = FUN_01051f38(uVar3);
        if (iVar7 != 2) {
          return;
        }
        uVar4 = 0x28;
      }
    }
    else {
      iVar7 = FUN_01051f38(uVar3);
      if (iVar7 == 3) {
        uVar4 = 0x1e;
      }
      else {
        iVar7 = FUN_01051f38(uVar3);
        if (iVar7 != 2) {
          return;
        }
        uVar4 = 0x3c;
      }
    }
    FUN_0108fad8(uVar4);
  }
  return;
}



/* FUN_0100b848 @ 0100b848 */

undefined4 FUN_0100b848(int param_1,undefined4 param_2,undefined4 param_3,int param_4)

{
  int *piVar1;
  int iVar2;
  undefined4 uVar3;
  int iVar4;
  uint uVar5;
  uint auStack_38 [2];
  undefined1 uStack_30;
  undefined1 uStack_2f;
  undefined1 uStack_2e;
  char cStack_2d;
  int iStack_2c;
  undefined1 auStack_28 [20];
  
  iVar2 = FUN_01006a84(0xe);
  piVar1 = DAT_0100b984;
  if (iVar2 == 0) {
    return 0;
  }
  if (2 < *DAT_0100b984) {
    uVar3 = FUN_010176e0(param_1);
    FUN_0108dd8c(0,PTR_s__INF__0100b988,0,uVar3,2,PTR_s_d_010fa76d_0x23_0100b98c,
                 *(undefined1 *)(iVar2 + 7),param_4);
  }
  func_0x0008009e(&uStack_30,0,0x1c);
  uStack_30 = 2;
  uStack_2f = (undefined1)param_1;
  cStack_2d = (char)param_3 + '\x04';
  uStack_2e = (undefined1)param_4;
  func_0x000800aa(auStack_28,param_2,param_3);
  iVar4 = FUN_01074600(iVar2,3);
  if (iVar4 != 0) {
    FUN_0100b7ec();
  }
  auStack_38[0] = FUN_01090054();
  auStack_38[1] = 0;
  if (param_4 != 0) {
    iVar4 = FUN_0107467c();
    iStack_2c = iVar4 + 0x140;
    FUN_0106c4e8(3,0x1e0,0x78,DAT_0100b990,2,iVar4,iStack_2c);
  }
  while( true ) {
    uVar3 = 6;
    if (*(char *)(iVar2 + 7) != '\x02') {
      uVar3 = 8;
    }
    iVar4 = FUN_0107427c(uVar3,&uStack_30,0x1c);
    if (iVar4 == 0x1c) break;
    if (param_1 - 0x15U < 2) {
      if (1 < *piVar1) {
        FUN_0104ba04(PTR_s___s__s__s___sskip_send_tws_event_0100b9a0,PTR_s_bt_mgr_0100b99c,
                     PTR_s__WRN__0100b998,PTR_s_bt_manager_tws_send_event_ex_0100b9a4,
                     PTR_s__010f8ede_0x1b_0100b994,param_1,PTR_s__010f8ede_0x1b_0100b994);
      }
      break;
    }
    uVar3 = FUN_01090054();
    uVar5 = FUN_0105e1fc(uVar3,auStack_38[0]);
    if (100 < uVar5) {
      FUN_0106c4e8(1,0x1e0,0x88,DAT_0100b9a8,0);
      return 0;
    }
    FUN_0108fad8(10);
  }
  if (param_4 != 0) {
    auStack_38[0] = FUN_010900b6(auStack_38);
    auStack_38[1] = 0;
    if (auStack_38[0] < 100) {
      FUN_0108fad8(100 - auStack_38[0]);
    }
  }
  return 1;
}



/* FUN_0100b7ec @ 0100b7ec */

undefined4 FUN_0100b7ec(void)

{
  int iVar1;
  undefined4 uVar2;
  int iVar3;
  undefined4 uVar4;
  uint uVar5;
  
  iVar1 = FUN_01006a84(0xe);
  if (iVar1 == 0) {
LAB_0100b836:
    uVar2 = 0;
  }
  else {
    uVar2 = FUN_01090054();
    while (iVar3 = FUN_01074600(iVar1,2), iVar3 != 0) {
      uVar4 = FUN_01090054();
      uVar5 = FUN_0105e1fc(uVar4,uVar2);
      if (100 < uVar5) {
        FUN_0106c4e8(1,0x1e0,0x3c,DAT_0100b844,0);
        goto LAB_0100b836;
      }
      FUN_0108fad8(10);
    }
    uVar2 = 1;
  }
  return uVar2;
}



/* FUN_01074600 @ 01074600 */

byte FUN_01074600(undefined4 param_1,uint param_2)

{
  int iVar1;
  undefined4 uVar2;
  byte bVar3;
  int iVar4;
  bool bVar5;
  undefined1 uStack_15;
  
  iVar1 = FUN_010783d8(param_1,&uStack_15);
  if ((iVar1 == 0) || (iVar4 = *(int *)(iVar1 + 0x3c), iVar4 == 0)) {
    bVar3 = 0;
  }
  else {
    bVar3 = *(byte *)(iVar4 + 6) >> 4;
    if (param_2 < 2) {
      *(byte *)(iVar4 + 6) = *(byte *)(iVar4 + 6) & 0xf0 | (byte)param_2 & 0xf;
      bVar5 = param_2 != 0;
    }
    else {
      bVar5 = param_2 != 3;
    }
    if (!bVar5) {
      uVar2 = FUN_01090054();
      *(undefined4 *)(iVar4 + 0xc) = uVar2;
      if ((*(byte *)(*(undefined2 **)(iVar1 + 0x3c) + 3) & 0xf0) != 0) {
        FUN_01074ce0(**(undefined2 **)(iVar1 + 0x3c));
      }
    }
  }
  return bVar3;
}



/* FUN_01008d64 @ 01008d64 */

void FUN_01008d64(int param_1)

{
  undefined4 *puVar1;
  int iVar2;
  undefined4 uVar3;
  undefined4 *puVar4;
  int iVar5;
  
  iVar2 = FUN_0100653c(PTR_FUN_01008e10,param_1,0);
  puVar1 = DAT_01008e14;
  if (iVar2 == 0) {
    if (param_1 == 0) {
      for (puVar4 = (undefined4 *)*DAT_01008e14; puVar4 != puVar1; puVar4 = (undefined4 *)*puVar4) {
        if (*(char *)((int)puVar4 + -0x23a) != '\0') {
          FUN_01008d64(puVar4 + -0x90);
        }
      }
      if ((*(byte *)((int)puVar1 + 0x111) & 2) != 0) {
        FUN_01008be4();
      }
    }
    else {
      iVar5 = param_1 + 0x218;
      iVar2 = FUN_0109094c(iVar5);
      if (iVar2 == 0) {
        FUN_0106c4e8(3,0x1bc,0x8f,PTR_LAB_01011126_2_01008e18,1,*(undefined1 *)(param_1 + 6));
        *(byte *)(param_1 + 10) = *(byte *)(param_1 + 10) | 1;
        FUN_010083b4(0,0);
        FUN_010096c4(param_1);
        FUN_01008cb0(param_1);
        uVar3 = FUN_01090054();
        *(undefined4 *)(param_1 + 0x250) = uVar3;
        FUN_01090810(iVar5,PTR_LAB_01008e1c,param_1);
        FUN_01090848(iVar5,100,100);
      }
    }
  }
  return;
}



/* FUN_010096c4 @ 010096c4 */

void FUN_010096c4(int param_1)

{
  int iVar1;
  undefined4 uVar2;
  uint uVar3;
  int iVar4;
  uint uVar5;
  
  if ((param_1 != 0) && (iVar1 = FUN_0100653c(PTR_FUN_010097b0,param_1,0), iVar1 == 0)) {
    iVar1 = FUN_0109094c(param_1 + 0x178);
    if (iVar1 != 0) {
      FUN_0109091c(param_1 + 0x178);
    }
    if ((*(byte *)(param_1 + 8) & 0x20) != 0) {
      uVar5 = (uint)*(byte *)(param_1 + 6);
      FUN_0106c4e8(3,0x1da,0x92,DAT_010097b4,1,uVar5);
      uVar2 = FUN_01090054();
      uVar3 = FUN_0105e1fc(uVar2,*(undefined4 *)(param_1 + 0x248));
      if (uVar3 < 2000) {
        iVar1 = param_1 + 0x1d8;
        iVar4 = FUN_0109094c(iVar1);
        if (iVar4 != 0) {
          return;
        }
        iVar4 = 2000 - uVar3;
        FUN_0106c4e8(3,0x1da,0x9c,DAT_010097b8,1,iVar4);
        FUN_01090810(iVar1,PTR_LAB_010097bc,param_1);
        uVar2 = 0;
      }
      else {
        iVar1 = param_1 + 0x1f8;
        iVar4 = FUN_0109094c(iVar1);
        if (iVar4 != 0) {
          FUN_0106c4e8(3,0x1da,0xa4,DAT_010097c0,0,uVar5);
          return;
        }
        uVar2 = FUN_01090054();
        *(undefined4 *)(param_1 + 0x24c) = uVar2;
        *(byte *)(param_1 + 10) = *(byte *)(param_1 + 10) & 0xdf;
        FUN_01006480(param_1,0x11,0);
        FUN_01090810(iVar1,PTR_LAB_010097c4,param_1);
        uVar2 = 100;
        iVar4 = 100;
      }
      FUN_01090848(iVar1,iVar4,uVar2);
    }
  }
  return;
}



/* FUN_010111a8 @ 010111a8 */

void FUN_010111a8(void)

{
  int *piVar1;
  int *piVar2;
  undefined *puVar3;
  int iVar4;
  
  piVar2 = DAT_01011220;
  piVar1 = DAT_01011218;
  if ((*DAT_01011218 != 0) && (*(char *)(*DAT_01011218 + 2) == '\0')) {
    FUN_0106c4e8(4,0x1c9,0x38d,DAT_0101121c,0);
    puVar3 = PTR_s__010f8ede_0x1b_01011224;
    while (iVar4 = FUN_01090054(), (uint)(iVar4 - *(int *)(*piVar1 + 0x6c)) < 100) {
      if (2 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___s_s_01011228,PTR_s_bt_mgr_01011234,PTR_s__INF__01011230,
                     PTR_s_csb_master_train_start_0101122c,puVar3,puVar3);
      }
      FUN_0108fad8(100);
    }
    FUN_01080fec(1);
    FUN_01081194();
    FUN_01081084();
    *(undefined1 *)(*piVar1 + 2) = 1;
  }
  return;
}



/* FUN_01011238 @ 01011238 */

void FUN_01011238(void)

{
  int *piVar1;
  undefined4 uVar2;
  int iVar3;
  
  piVar1 = DAT_0101127c;
  if ((*DAT_0101127c != 0) && (*(char *)(*DAT_0101127c + 2) == '\x01')) {
    FUN_0106c4e8(4,0x1c9,0x39e,DAT_01011280,0);
    iVar3 = *piVar1;
    uVar2 = FUN_01090054();
    *(undefined4 *)(iVar3 + 0x6c) = uVar2;
    FUN_010807a0();
    FUN_01080fec(0);
    *(undefined1 *)(*piVar1 + 2) = 0;
  }
  return;
}



/* FUN_01071050 @ 01071050 */

void FUN_01071050(int param_1,uint param_2,int param_3)

{
  byte bVar1;
  undefined2 uVar2;
  int iVar3;
  int iVar4;
  char cVar5;
  undefined4 uVar6;
  uint uVar7;
  undefined *puVar8;
  byte *pbVar9;
  byte bVar10;
  int iVar11;
  byte bStack_1c;
  
  if ((param_1 == 0) || (pbVar9 = *(byte **)(param_1 + 0x44), pbVar9 == (byte *)0x0)) {
    uVar6 = 1;
  }
  else {
    if (pbVar9[5] != 1) {
      uVar7 = (uint)pbVar9[1];
      if (param_2 < pbVar9[1]) {
        uVar7 = param_2;
      }
      if (pbVar9[6] == 3) {
        iVar3 = FUN_01050470(param_1);
        if (iVar3 == 0) {
          uVar6 = 3;
          goto LAB_01071070;
        }
        *(short *)(pbVar9 + 0xc) = (short)param_3;
      }
      else if (pbVar9[6] == 1) {
        cVar5 = *(char *)(param_1 + 8);
        if (cVar5 == '\0') {
          cVar5 = '0';
        }
        uVar6 = func_0x0000049c(param_3 * 1000,cVar5);
        if (2 < *DAT_01071218) {
          FUN_0104ba04(PTR_s___s__s__s___sfade_time__d_us_in_p_01071228,PTR_s_general_01071224,
                       PTR_s__INF__01071220,PTR_s_audio_track_set_fade_volume_wait_01071208,
                       PTR_s__010f8ede_0x1b_0107121c,uVar6,PTR_s__010f8ede_0x1b_0107121c);
        }
        uVar2 = func_0x0000050c(uVar6,200);
        *(undefined2 *)(pbVar9 + 0xc) = uVar2;
      }
      bStack_1c = (byte)uVar7;
      bVar10 = *pbVar9;
      pbVar9[2] = bStack_1c;
      pbVar9[10] = 0;
      pbVar9[0xb] = 0;
      pbVar9[0x10] = 0;
      pbVar9[0x11] = 0;
      pbVar9[0x12] = 0;
      pbVar9[0x13] = 0;
      iVar3 = FUN_01090054();
      if ((uint)*pbVar9 < (uVar7 & 0xff)) {
        pbVar9[3] = 1;
        if (pbVar9[6] == 3) {
          *(int *)(pbVar9 + 0x10) =
               (int)*(short *)(PTR_DAT_01071210 + (*pbVar9 + 1) * 2) -
               (int)*(short *)(PTR_DAT_01071210 + (uint)*pbVar9 * 2);
        }
        else if (pbVar9[6] == 1) {
          *(int *)(pbVar9 + 0x10) =
               *(int *)(PTR_DAT_0107122c + (*pbVar9 + 1) * 4) -
               *(int *)(PTR_DAT_0107122c + (uint)*pbVar9 * 4);
          FUN_01070cb0(param_1);
        }
        iVar11 = 0;
        do {
          if (pbVar9[3] == 0) break;
          FUN_0108fad8(1);
          bVar1 = *pbVar9;
          if (bVar10 == bVar1) {
            iVar11 = iVar11 + 1;
            if (iVar11 == 0x14) {
              iVar3 = 0x91;
              puVar8 = PTR_DAT_01071214;
LAB_01071122:
              FUN_0106c4e8(2,0x114,iVar3 << 2,puVar8,1,bVar10);
              break;
            }
          }
          else {
            iVar11 = 0;
          }
          iVar4 = FUN_01090054();
          bVar10 = bVar1;
        } while ((uint)(iVar4 - iVar3) < 0x3e9);
      }
      else if ((uVar7 & 0xff) < (uint)*pbVar9) {
        pbVar9[4] = 1;
        if (pbVar9[6] == 3) {
          *(int *)(pbVar9 + 0x10) =
               (int)*(short *)(PTR_DAT_01071210 + (uint)*pbVar9 * 2) -
               (int)*(short *)(PTR_DAT_01071210 + (*pbVar9 - 1) * 2);
        }
        else if (pbVar9[6] == 1) {
          *(int *)(pbVar9 + 0x10) =
               *(int *)(PTR_DAT_0107122c + (uint)*pbVar9 * 4) -
               *(int *)(PTR_DAT_0107122c + (*pbVar9 - 1) * 4);
          FUN_01070cb0(param_1);
        }
        iVar11 = 0;
        do {
          if (pbVar9[4] == 0) break;
          FUN_0108fad8(1);
          bVar1 = *pbVar9;
          if (bVar10 == bVar1) {
            iVar11 = iVar11 + 1;
            if (iVar11 == 0x14) {
              iVar3 = 0x98;
              puVar8 = PTR_DAT_01071268;
              goto LAB_01071122;
            }
          }
          else {
            iVar11 = 0;
          }
          iVar4 = FUN_01090054();
          bVar10 = bVar1;
        } while ((uint)(iVar4 - iVar3) < 0x3e9);
      }
      pbVar9[5] = 2;
      return;
    }
    uVar6 = 2;
  }
LAB_01071070:
  FUN_0104ba04(PTR_s__s_fade_failed__d_0107120c,PTR_s_audio_track_set_fade_volume_wait_01071208,
               uVar6);
  return;
}



/* FUN_01076614 @ 01076614 */

void FUN_01076614(void)

{
  undefined4 uVar1;
  undefined4 auStack_18 [3];
  undefined1 uStack_a;
  
  func_0x0008009e(auStack_18,0,0x14);
  auStack_18[0] = 2;
  uStack_a = 1;
  FUN_01095ae8(0,0,auStack_18,PTR_LAB_0107665c);
  if (2 < *DAT_01076660) {
    uVar1 = FUN_01090054();
    FUN_0104ba04(PTR_s___s__s__s___sScaner_Enable___d_s_01076670,PTR_s_general_0107666c,
                 PTR_s__INF__01076668,PTR_s_APP_LE_Set_Discovery_01076674,
                 PTR_s__010f8ede_0x1b_01076664,uVar1,PTR_s__010f8ede_0x1b_01076664);
  }
  return;
}



/* FUN_01083010 @ 01083010 */

void FUN_01083010(void)

{
  int *piVar1;
  int *piVar2;
  undefined *puVar3;
  undefined1 uVar4;
  byte bVar5;
  ushort uVar6;
  int iVar7;
  uint uVar8;
  undefined4 uVar9;
  undefined4 uVar10;
  char cVar11;
  char *pcVar12;
  uint uVar13;
  short sVar14;
  undefined1 *puVar15;
  uint uVar16;
  int iVar17;
  undefined *puVar18;
  uint uStack_18;
  
  piVar1 = DAT_010831b4;
  FUN_0108f0e4(DAT_010831b0,0xffffffff);
  pcVar12 = (char *)*piVar1;
  if ((pcVar12 == (char *)0x0) || (*pcVar12 != '\x03')) goto LAB_01083038;
  if (pcVar12[0x9a] == '\x03') {
    FUN_01082e3c();
    goto LAB_01083038;
  }
  if (pcVar12[0x9a] == '\x01') {
    FUN_01082e3c();
    if ((*(char *)(*piVar1 + 0x9a) != '\x02') && (*(short *)(*piVar1 + 0x36) != 1))
    goto LAB_01083038;
  }
  if (*(char *)(*piVar1 + 0x9a) != '\x02') goto LAB_01083038;
  iVar7 = FUN_0105d79c();
  uVar16 = 3;
  if (iVar7 == 1) {
    uVar16 = 5;
  }
  if (*(char *)(*piVar1 + 0x3d) == '\0') {
LAB_010830ae:
    iVar7 = *piVar1;
    if ((*(byte *)(iVar7 + 0x3c) == 0) ||
       (*(ushort *)(iVar7 + 0x3a) < (ushort)*(byte *)(iVar7 + 0x3c))) goto LAB_01083038;
    uVar9 = FUN_01090054();
    *(undefined4 *)(iVar7 + 0x40) = uVar9;
    uStack_18 = FUN_0108512c(1);
    puVar3 = PTR_s__010f8ede_0x1b_010831bc;
    piVar2 = DAT_010831b8;
    while (uStack_18 < 3) {
      iVar7 = *piVar1;
      uVar16 = (uint)*(byte *)(iVar7 + 0x3c);
      if (*(ushort *)(iVar7 + 0x3a) < uVar16) break;
      uVar8 = (uint)*(ushort *)(iVar7 + 0x3e);
      puVar15 = *(undefined1 **)(iVar7 + 4);
      if (*(char *)(iVar7 + 0x98) == '\x02') {
        iVar7 = FUN_0108f58c(iVar7 + 0x238,0);
        if (iVar7 == 0) {
LAB_010832ea:
          puVar15[10] = 0;
          puVar15[0xb] = 0;
          puVar15[0xc] = 0;
          puVar15[0xd] = 0;
          puVar15[3] = 0;
        }
        else {
          uVar16 = uVar16 - 1;
          puVar15[10] = *(undefined1 *)(iVar7 + 8);
          puVar15[0xb] = *(undefined1 *)(iVar7 + 9);
          puVar15[0xc] = *(undefined1 *)(iVar7 + 10);
          puVar15[0xd] = *(undefined1 *)(iVar7 + 0xb);
          puVar15[8] = *(undefined1 *)(iVar7 + 0xc);
          puVar15[9] = *(undefined1 *)(iVar7 + 0xd);
          puVar15[3] = *(undefined1 *)(iVar7 + 5);
          *(undefined1 *)(iVar7 + 4) = 0;
        }
      }
      else {
        iVar7 = FUN_0108f58c(iVar7 + 0x238,0);
        if (iVar7 == 0) goto LAB_010832ea;
        uVar16 = uVar16 - 1;
        FUN_01082fdc(puVar15 + 3);
        puVar15[3] = 0xf;
        *(undefined1 *)(iVar7 + 4) = 0;
      }
      iVar7 = *piVar1;
      puVar15[0xe] = *(undefined1 *)(iVar7 + 0x3c);
      puVar15[3] = puVar15[3] | *(byte *)(iVar7 + 0x234);
      uVar13 = uVar8 + 0x14 & 0xffff;
      *puVar15 = (char)uVar13;
      puVar15[1] = (char)(uVar13 >> 8);
      puVar15[2] = 0xae;
      FUN_01085168(3,&uStack_18);
      iVar7 = FUN_0108a628();
      uVar9 = func_0x00080082();
      if (3 < *piVar2) {
        iVar17 = func_0x0000050c(uVar9,0x18);
        FUN_0104ba04(PTR_s___s__s__s___sput_list__u__d__d___010831cc,PTR_s_general_010831c0,
                     PTR_s__DBG__010831c8,PTR_s_audio_data_send_to_csb_ext_010831c4,puVar3,uStack_18
                     ,uStack_18 - *(int *)(puVar15 + 10),iVar7,iVar17,iVar17 - iVar7,puVar3);
      }
      if ((((*(byte *)(*piVar1 + 0x231) & 0xe) != 0) && (iVar7 = FUN_0105d610(), iVar7 == 0)) &&
         (iVar7 = FUN_0105d696(), iVar7 != 0)) {
        sVar14 = *(short *)(*piVar1 + 0x36) + 1;
        *(short *)(*piVar1 + 0x36) = sVar14;
        if (1 < *piVar2) {
          uVar9 = FUN_0105d696();
          puVar3 = PTR_s__010f8ede_0x1b_01083330;
          uVar10 = func_0x00080082();
          puVar18 = puVar3;
          uVar10 = func_0x0000050c(uVar10,0x18);
          FUN_0104ba04(PTR_s___s__s__s___sdrop_data__d__d__d__01083334,PTR_s_general_01083340,
                       PTR_s__WRN__0108333c,PTR_s_audio_data_send_to_csb_ext_01083338,puVar3,sVar14,
                       uVar9,uVar10,puVar18);
        }
        FUN_010729f8(*(undefined4 *)(*piVar1 + 0x218),puVar15 + 0x14,*(undefined1 *)(*piVar1 + 0x3d)
                    );
        goto LAB_01083038;
      }
      uVar13 = FUN_010729f8(*(undefined4 *)(*piVar1 + 0x218),puVar15 + 0x14,uVar8);
      if (uVar8 != uVar13) {
        FUN_0106c4e8(3,0x164,0x55f,PTR_DAT_01083344,0);
        break;
      }
      iVar7 = *piVar1;
      *(ushort *)(iVar7 + 0x3a) = *(short *)(iVar7 + 0x3a) - (ushort)*(byte *)(iVar7 + 0x3c);
      while (uVar16 != 0) {
        iVar7 = FUN_0108f58c(*piVar1 + 0x238,0);
        uVar16 = uVar16 - 1;
        if (iVar7 == 0) {
          FUN_0106c4e8(3,0x164,0x569,PTR_DAT_01083468,0);
          goto LAB_01083038;
        }
        *(undefined1 *)(iVar7 + 4) = 0;
      }
      iVar7 = *piVar1;
      uVar16 = (uint)*(ushort *)(iVar7 + 0x36) + (uint)*(byte *)(iVar7 + 0x3c);
      uVar8 = uVar16 & 0xffff;
      *(short *)(iVar7 + 0x36) = (short)uVar16;
      puVar15[6] = (char)uVar8;
      puVar15[7] = (char)(uVar8 >> 8);
      uVar4 = FUN_0105d5f8();
      iVar7 = *piVar1;
      puVar15[0xf] = uVar4;
      if (((*(byte *)(iVar7 + 0x231) & 0xe) == 0) && (*(char *)(iVar7 + 0x233) != '\0')) {
        bVar5 = puVar15[0x13] & 0xfe;
      }
      else {
        bVar5 = puVar15[0x13] | 1;
      }
      puVar15[0x13] = bVar5;
      bVar5 = FUN_0105d610();
      puVar15[0x13] = puVar15[0x13] & 0xe7 | (bVar5 & 3) << 3;
      bVar5 = *(byte *)(*piVar1 + 0x233);
      puVar15[0x13] = puVar15[0x13] & 0xf9 | (bVar5 & 3) << 1;
      if (3 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___sasrc_mode__d__s_01083454,PTR_s_general_01083460,
                     PTR_s__DBG__0108345c,PTR_s_audio_data_send_to_csb_ext_01083458,puVar3,bVar5,
                     puVar3);
      }
      for (uVar16 = (uint)*(byte *)(*piVar1 + 0x232); uVar16 != 0; uVar16 = uVar16 - 1) {
        uStack_18 = FUN_01085530(puVar15,1,1);
        if (uStack_18 == 0) {
          FUN_0106c4e8(1,0x164,0x588,PTR_DAT_01083464,0);
          break;
        }
      }
      if (*(ushort *)(*piVar1 + 0x3a) < (ushort)*(byte *)(*piVar1 + 0x3c)) break;
      uStack_18 = FUN_0108512c(1);
    }
    if ((*(byte *)(*piVar1 + 0x231) & 0xe) == 0) goto LAB_01083038;
  }
  else {
    iVar7 = FUN_0105d594();
    iVar17 = *piVar1;
    uVar8 = func_0x0000050c(iVar7 + -0x17,*(undefined1 *)(iVar17 + 0x3d));
    uVar9 = func_0x00080420(*(undefined4 *)(iVar17 + 0x218));
    iVar7 = *piVar1;
    uVar6 = func_0x0000049c(uVar9,*(undefined1 *)(iVar7 + 0x3d));
    bVar5 = *(byte *)(iVar7 + 0x231) & 0xe;
    *(ushort *)(iVar7 + 0x3a) = uVar6;
    if ((*(byte *)(iVar7 + 0x231) & 0xe) == 0) {
      *(char *)(iVar7 + 0x3c) = (char)uVar8;
      goto LAB_010830a0;
    }
    if (bVar5 == 2) {
      if (uVar6 < 3) {
        cVar11 = ~(uVar6 != 2) + 1;
      }
      else {
        cVar11 = '\x03';
      }
LAB_01083260:
      *(char *)(iVar7 + 0x3c) = cVar11;
LAB_010830a0:
      iVar7 = *piVar1;
      *(ushort *)(iVar7 + 0x3e) = (ushort)*(byte *)(iVar7 + 0x3d) * (ushort)*(byte *)(iVar7 + 0x3c);
      goto LAB_010830ae;
    }
    if (bVar5 == 4) {
      cVar11 = '\x02';
      goto LAB_01083260;
    }
    if ((bVar5 == 6) && (iVar7 = FUN_0105d610(), iVar7 == 0)) {
      *(undefined1 *)(*piVar1 + 0x3c) = 3;
      goto LAB_010830a0;
    }
    if (((*(byte *)(*piVar1 + 0x231) & 0xe) != 6) || (iVar7 = FUN_0105d610(), iVar7 != 1))
    goto LAB_010830a0;
    iVar7 = FUN_0108512c();
    if ((iVar7 == 0) && (iVar7 = FUN_0105d696(), iVar7 < 1)) {
      uVar13 = (uint)*(ushort *)(*piVar1 + 0x3a);
      if (uVar13 < uVar16) goto LAB_01083038;
      if (uVar13 < uVar8) {
        uVar8 = uVar13;
      }
      *(char *)(*piVar1 + 0x3c) = (char)uVar8;
      goto LAB_010830a0;
    }
  }
  FUN_01085188();
LAB_01083038:
  FUN_0108f1b0(DAT_010831b0);
  return;
}



/* FUN_0108346c @ 0108346c */

void FUN_0108346c(void)

{
  int *piVar1;
  undefined2 uVar2;
  undefined4 uVar3;
  uint uVar4;
  uint uVar5;
  ushort uVar6;
  int iVar7;
  undefined1 uVar8;
  char cVar9;
  char *pcVar10;
  undefined1 *puVar11;
  short sVar12;
  uint uStack_20;
  
  piVar1 = DAT_01083640;
  FUN_0108f0e4(DAT_0108363c,0xffffffff);
  pcVar10 = (char *)*piVar1;
  if ((pcVar10 != (char *)0x0) && (*pcVar10 == '\x03')) {
    if ((pcVar10[0x9a] & 0xfdU) == 1) {
      FUN_01082e3c();
    }
    else if ((((*(ushort *)(pcVar10 + 0x3a) != 0) && (pcVar10[0x9a] == 2)) &&
             ((byte)pcVar10[0x3c] != 0)) &&
            ((ushort)(byte)pcVar10[0x3c] <= *(ushort *)(pcVar10 + 0x3a))) {
      uVar3 = FUN_01090054();
      *(undefined4 *)(pcVar10 + 0x40) = uVar3;
      uVar4 = FUN_0108512c(1);
      do {
        if (uVar4 == 0) {
          if (*(ushort *)(*piVar1 + 0x3a) < (ushort)*(byte *)(*piVar1 + 0x3c)) goto LAB_010834da;
        }
        else {
          if (2 < uVar4) break;
LAB_010834da:
          if (*(ushort *)(*piVar1 + 0x3a) < 0x47) break;
        }
        iVar7 = *piVar1;
        uStack_20 = (uint)*(ushort *)(iVar7 + 0x3e);
        puVar11 = *(undefined1 **)(iVar7 + 4);
        puVar11[6] = *(undefined1 *)(iVar7 + 0x36);
        puVar11[7] = *(undefined1 *)(iVar7 + 0x37);
        if (*(char *)(iVar7 + 0x98) == '\x02') {
          iVar7 = FUN_01082160(0);
          if (iVar7 == 0) {
            puVar11[10] = 0;
            puVar11[0xb] = 0;
LAB_01083540:
            uVar8 = 0;
            puVar11[0xc] = 0;
            puVar11[0xd] = 0;
          }
          else {
            iVar7 = *piVar1;
            puVar11[10] = *(undefined1 *)(iVar7 + 0x54);
            puVar11[0xb] = *(undefined1 *)(iVar7 + 0x55);
            uVar2 = *(undefined2 *)(iVar7 + 0x58);
            puVar11[0xc] = *(undefined1 *)(iVar7 + 0x56);
            puVar11[0xd] = *(undefined1 *)(iVar7 + 0x57);
            puVar11[8] = (char)uVar2;
            puVar11[9] = (char)((ushort)uVar2 >> 8);
            uVar8 = *(undefined1 *)(iVar7 + 0x34);
          }
          puVar11[3] = uVar8;
        }
        else {
          iVar7 = FUN_01082160(0);
          if (iVar7 == 0) {
            puVar11[10] = 0;
            puVar11[0xb] = 0;
            goto LAB_01083540;
          }
          FUN_01082fdc(puVar11 + 3);
        }
        iVar7 = *piVar1;
        puVar11[0xe] = *(undefined1 *)(iVar7 + 0x3c);
        if (*(ushort *)(iVar7 + 0x3a) < 0x46) {
          uVar4 = FUN_0108512c(1);
          uVar5 = FUN_01085140();
          if (uVar4 < uVar5) {
            uStack_20 = uStack_20 - *(byte *)(*piVar1 + 0x3d);
            puVar11[0xe] = puVar11[0xe] + -1;
          }
        }
        uVar4 = uStack_20 + 0xf & 0xffff;
        puVar11[2] = 0xae;
        *puVar11 = (char)uVar4;
        puVar11[1] = (char)(uVar4 >> 8);
        iVar7 = *piVar1;
        sVar12 = *(short *)(iVar7 + 0x228);
        if ((*(ushort *)(iVar7 + 0x5e) == 0) && (*(char *)(iVar7 + 0x3c) == '\0')) {
          sVar12 = 0;
        }
        else {
          if (*(short *)(iVar7 + 0x22c) == 0) {
            uVar2 = func_0x0000049c((uint)*(ushort *)(iVar7 + 0x5e) * 10,
                                    *(undefined1 *)(iVar7 + 0x22e));
            *(undefined2 *)(iVar7 + 0x22c) = uVar2;
            uVar2 = func_0x000005cc((uint)*(byte *)(iVar7 + 0x3c) << 7,uVar2);
            *(undefined2 *)(iVar7 + 0x22a) = uVar2;
          }
          uVar6 = *(short *)(iVar7 + 0x22a) + sVar12;
          *(ushort *)(iVar7 + 0x228) = uVar6;
          if (*(ushort *)(iVar7 + 0x22c) <= uVar6) {
            *(ushort *)(iVar7 + 0x228) = uVar6 - *(ushort *)(iVar7 + 0x22c);
          }
        }
        puVar11[4] = (char)sVar12;
        puVar11[5] = (char)((ushort)sVar12 >> 8);
        uVar4 = FUN_010729f8(*(undefined4 *)(iVar7 + 0x218),puVar11 + 0xf,uStack_20);
        if (uStack_20 != uVar4) break;
        if (puVar11[0xf] != -100) {
          FUN_0106c4e8(2,0x164,0x615,PTR_DAT_01083644,2,puVar11[0xf],uStack_20);
          *(undefined2 *)(*piVar1 + 0x3a) = 0;
          do {
            iVar7 = FUN_010729f8(*(undefined4 *)(*piVar1 + 0x218),puVar11 + 0xf,uStack_20);
          } while (0 < iVar7);
          cVar9 = *(char *)(*piVar1 + 0x22f) + '\x01';
          *(char *)(*piVar1 + 0x22f) = cVar9;
          if (cVar9 == -0x38) {
            FUN_0104ba04(PTR_s_send_data_error_010836e8);
            *(undefined1 *)(*piVar1 + 0x22f) = 0;
            FUN_0107c100(0,0x46,0);
          }
          break;
        }
        iVar7 = *piVar1;
        *(short *)(iVar7 + 0x36) = *(short *)(iVar7 + 0x36) + 1;
        *(ushort *)(iVar7 + 0x3a) = *(short *)(iVar7 + 0x3a) - (ushort)(byte)puVar11[0xe];
        iVar7 = FUN_01085530(puVar11,1,1);
        if (iVar7 == 0) {
          FUN_0106c4e8(1,0x164,0x630,PTR_DAT_010836ec,0);
          break;
        }
        if (*(ushort *)(*piVar1 + 0x3a) < (ushort)*(byte *)(*piVar1 + 0x3c)) break;
        uVar4 = FUN_0108512c(1);
      } while( true );
    }
  }
  FUN_0108f1b0(DAT_0108363c);
  return;
}



/* FUN_01082160 @ 01082160 */

undefined4 FUN_01082160(uint param_1,uint param_2)

{
  char cVar1;
  undefined4 uVar2;
  uint uVar3;
  uint uVar4;
  int iVar5;
  uint uVar6;
  uint uVar7;
  undefined *puVar8;
  uint uVar9;
  char *pcVar10;
  uint uVar11;
  uint uStack_44;
  int *piStack_40;
  uint uStack_3c;
  uint uStack_38;
  ushort uStack_26;
  int iStack_24;
  uint uStack_20;
  uint uStack_1c;
  int iStack_18;
  
  pcVar10 = (char *)*DAT_01082274;
  iStack_24 = 0;
  uStack_20 = 0;
  uStack_1c = 0;
  iStack_18 = 0;
  uStack_26 = 0;
  if (param_1 == 0) {
    pcVar10[0x44] = '\0';
    pcVar10[0x45] = '\0';
    pcVar10[0x46] = '\0';
    pcVar10[0x47] = '\0';
  }
  else if (*(int *)(pcVar10 + 0x44) == 0) {
    uVar2 = FUN_01090054();
    *(undefined4 *)(pcVar10 + 0x44) = uVar2;
  }
  else {
    iVar5 = FUN_01090054();
    if ((uint)(iVar5 - *(int *)(pcVar10 + 0x44)) < param_1) {
      return 0;
    }
  }
  if (pcVar10 == (char *)0x0) {
    return 0;
  }
  if (*pcVar10 != '\x03') {
    return 0;
  }
  if (*(int *)(pcVar10 + 0x218) == 0) {
    return 0;
  }
  func_0x000808e4();
  uVar3 = func_0x00080420(*(undefined4 *)(pcVar10 + 0x218));
  uVar4 = FUN_0107b3a4();
  if (((*(int *)(pcVar10 + 100) == 0) || (*(uint *)(pcVar10 + 0x6c) == 0)) ||
     (*(int *)(pcVar10 + 0x70) == 0)) {
    uStack_44 = 0;
    piStack_40 = (int *)0x0;
  }
  else {
    piStack_40 = &iStack_24;
    iVar5 = (*(code *)(*(uint *)(pcVar10 + 0x6c) & 0xfffffffe))
                      (*(int *)(pcVar10 + 100),piStack_40,&uStack_20,&uStack_26);
    if (iVar5 != 0) goto LAB_010821dc;
    uStack_44 = (*(code *)(*(uint *)(pcVar10 + 0x70) & 0xfffffffe))(*(undefined4 *)(pcVar10 + 100));
  }
  iVar5 = func_0x000807be(1,&uStack_1c,&iStack_18);
  if (((param_2 & 0x80000000) == 0) && ((uVar3 & 0x80000000) == 0)) {
    if (iVar5 == 0) {
      cVar1 = pcVar10[0x3d];
      uStack_1c = uStack_1c & 0xfffffffc;
      *(uint *)(pcVar10 + 0x54) = uStack_1c * 0x138 + (uStack_1c >> 1) + iStack_18;
      if (cVar1 != '\0') {
        uVar7 = (uint)CARRY4((uint)uStack_26,(uint)*(ushort *)(pcVar10 + 0x5c) * 0x10000);
        iVar5 = (uint)uStack_26 + (uint)*(ushort *)(pcVar10 + 0x5c) * 0x10000 + 1;
        if (iVar5 == 0) {
          uVar7 = uVar7 + 1;
        }
        uVar6 = func_0x00000588(iVar5,uVar7,iStack_24,0);
        uStack_3c = (uVar6 - uStack_20) - uStack_44;
        uStack_38 = ((uVar7 - (uStack_20 <= uVar6 ^ 1)) - (int)piStack_40) -
                    (uStack_44 <= uVar6 - uStack_20 ^ 1);
        if ((uStack_38 & 0x80000000) != 0) {
          uStack_3c = 0;
          uStack_38 = 0;
        }
        iVar5 = (param_2 - ((int)uVar3 >> 0x1f)) - (uVar3 <= uVar4 ^ 1);
        uVar6 = FUN_010005ac(uVar4 - uVar3,iVar5,cVar1,0);
        uVar9 = uVar6 >> 0x19 | iVar5 << 7;
        uVar6 = uVar6 * 0x80;
        uVar11 = uStack_3c >> 2 | uStack_38 << 0x1e;
        uVar7 = uVar6 - uVar11;
        uVar11 = (uVar9 - ((int)uStack_38 >> 2)) - (uVar11 <= uVar6 ^ 1);
        if (((int)uVar11 < 1) && ((uVar11 != 0 || (uVar7 < 0x10001)))) {
          if ((uVar11 & 0x80000000) != 0) {
            FUN_0106c4e8(3,0x164,0x1c8,PTR_DAT_010824bc,3,uVar7,uVar3,uVar6);
            uVar4 = (uint)(byte)pcVar10[0x3d];
            uVar6 = (uint)uStack_26;
            iVar5 = iStack_24;
            uVar3 = uStack_20;
            FUN_0106c4e8(3,0x164,0x1c9,PTR_DAT_010824b4,4,uVar6,iStack_24,uStack_20,uVar4);
            cVar1 = pcVar10[0x22f];
            pcVar10[0x22f] = cVar1 + '\x01';
            if ((char)(cVar1 + '\x01') == -0x38) {
              FUN_0106c4e8(2,0x164,0x1cf,PTR_DAT_010824b8,0,uVar6,iVar5,uVar3,uVar4);
              pcVar10[0x22f] = '\0';
              FUN_0107c100(0,0x46,0);
            }
          }
        }
        else {
          FUN_0106c4e8(3,0x164,0x1a8,PTR_DAT_010824a8,0);
          iVar5 = uStack_38 + CARRY4(uStack_3c,iStack_24 * 0x10000);
          uVar11 = uStack_3c + iStack_24 * 0x10000 >> 2 | iVar5 * 0x40000000;
          uVar7 = uVar6 - uVar11;
          if ((uVar9 - (iVar5 >> 2) != (uVar11 <= uVar6 ^ 1)) || (0x10000 < uVar7)) {
            FUN_0106c4e8(1,0x164,0x1b0,PTR_DAT_010824ac,0);
            FUN_0106c4e8(3,0x164,0x1b1,PTR_DAT_010824b0,3,uVar7,uVar3,uVar4);
            uVar4 = (uint)uStack_26;
            iVar5 = iStack_24;
            uVar3 = uStack_20;
            FUN_0106c4e8(3,0x164,0x1b2,PTR_DAT_010824b4,3,uVar4,iStack_24,uStack_20);
            FUN_0108f974();
            cVar1 = pcVar10[0x22f];
            pcVar10[0x22f] = cVar1 + '\x01';
            if ((char)(cVar1 + '\x01') != -0x38) {
              return 0;
            }
            FUN_0106c4e8(2,0x164,0x1b7,PTR_DAT_010824b8,0,uVar4,iVar5,uVar3);
            pcVar10[0x22f] = '\0';
            FUN_0107c100(0,0x46,0);
            return 0;
          }
          *(short *)(pcVar10 + 0x5c) = *(short *)(pcVar10 + 0x5c) + 1;
        }
        *(uint *)(pcVar10 + 0x58) = uVar7;
        uVar2 = FUN_01090054();
        *(undefined4 *)(pcVar10 + 0x44) = uVar2;
        FUN_0108f974();
        return 1;
      }
      uVar2 = 0x18e;
      puVar8 = PTR_DAT_01082278;
    }
    else {
      uVar2 = 0x185;
      puVar8 = PTR_DAT_0108227c;
    }
    FUN_0106c4e8(3,0x164,uVar2,puVar8,0);
  }
LAB_010821dc:
  FUN_0108f974();
  return 0;
}



/* FUN_010531cc @ 010531cc */

int FUN_010531cc(undefined4 param_1,uint param_2)

{
  int iVar1;
  int iVar2;
  uint uVar3;
  uint uVar4;
  int iVar5;
  undefined4 uVar6;
  uint uVar7;
  uint uVar8;
  uint uVar9;
  undefined1 auStack_1c [8];
  
  uVar7 = param_2;
  iVar1 = FUN_010517fc();
  if (iVar1 != 0) {
    func_0x000805dc(auStack_1c);
    iVar2 = FUN_010525c4();
    if ((iVar2 == 0) && (iVar2 = FUN_0105259c(), iVar2 != 0)) {
      uVar3 = FUN_01080fe0();
      uVar9 = uVar3 >> 2 | uVar7 << 0x1e;
      uVar3 = (int)uVar7 >> 2;
    }
    else if (param_2 == 9) {
      uVar9 = FUN_0107b3e8();
      uVar3 = uVar7 << 7 | uVar9 >> 0x19;
      uVar9 = uVar9 << 7;
    }
    else if (param_2 == 0x12) {
      FUN_0107b3e8();
      uVar9 = func_0x00000588();
      uVar3 = uVar7;
    }
    else if (param_2 == 7) {
      uVar3 = FUN_0107b3e8();
      uVar9 = uVar3 << 9;
      uVar3 = uVar7 << 9 | uVar3 >> 0x17;
    }
    else {
      uVar9 = 0;
      uVar3 = 0;
    }
    uVar4 = FUN_01050592(iVar1);
    func_0x0008060c(auStack_1c);
    uVar8 = uVar4 >> 2 | uVar7 << 0x1e;
    iVar2 = uVar9 - uVar8;
    if (((uVar3 - ((int)uVar7 >> 2)) - (uVar8 <= uVar9 ^ 1) & 0x80000000) == 0) {
      iVar5 = FUN_010504be(iVar1);
      iVar5 = iVar5 + iVar2 * 4;
      if (3 < *DAT_010532f8) {
        uVar6 = FUN_01090054();
        FUN_0104ba04(PTR_s___s__s__s___s_u__u__u__u_s_01053304,PTR_s_audio_system_01053300,
                     PTR_s__DBG__0105330c,PTR_s_audio_system_get_monitor_cache_s_01053308,
                     PTR_s__010f8ede_0x1b_010532fc,uVar9,uVar8,iVar5,uVar6,
                     PTR_s__010f8ede_0x1b_010532fc);
      }
      *(int *)(iVar1 + 0x54) = iVar5;
      return iVar5;
    }
    FUN_0106c4e8(3,0x189,0xd6,DAT_010532f0,2,iVar2,uVar9);
    FUN_0106c4e8(3,0x189,0xd7,DAT_010532f4,3,uVar9,uVar4,iVar2);
  }
  return 0;
}



/* FUN_01082504 @ 01082504 */

void FUN_01082504(int param_1,uint param_2)

{
  bool bVar1;
  char cVar2;
  char cVar3;
  ushort uVar4;
  undefined2 uVar5;
  int *piVar6;
  undefined4 uVar7;
  int iVar8;
  int iVar9;
  uint uVar10;
  uint uVar11;
  uint uVar12;
  int iVar13;
  undefined *puVar14;
  char *pcVar15;
  int iVar16;
  int iVar17;
  uint uStack_68;
  uint uStack_64;
  uint uStack_60;
  int iStack_5c;
  uint uStack_58;
  uint *puStack_54;
  int iStack_50;
  undefined4 uStack_4c;
  ushort uStack_32;
  uint uStack_30;
  uint uStack_2c;
  uint local_28;
  uint uStack_24;
  int local_20;
  uint uStack_1c;
  uint uStack_18;
  
  piVar6 = DAT_01082698;
  uStack_1c = 0;
  uStack_18 = 0;
  pcVar15 = (char *)*DAT_01082698;
  uStack_30 = 0;
  uStack_2c = 0;
  local_28 = 0xffffffff;
  uStack_32 = 0;
  uStack_24 = 0;
  local_20 = 0;
  if (pcVar15 == (char *)0x0) {
    FUN_0106c4e8(1,0x164,0x232,PTR_DAT_0108269c,0);
    return;
  }
  uStack_68 = param_2;
  if (*(int *)(pcVar15 + 0x44) == 0) {
    uVar7 = FUN_01090054();
    *(undefined4 *)(pcVar15 + 0x44) = uVar7;
  }
  if (*pcVar15 != '\x04') {
    return;
  }
  if (*(int *)(pcVar15 + 0x54) == 0) {
    return;
  }
  func_0x000808e4();
  uStack_4c = FUN_0107b3a4();
  if ((((uStack_68 & 0x80000000) == 0) && (*(int *)(pcVar15 + 100) != 0)) &&
     (*(int *)(pcVar15 + 0x6c) != 0)) {
    if (*(char *)(*piVar6 + 0x233) == '\0') {
      do {
        if (uStack_2c - local_28 == 2) break;
        iVar8 = FUN_01081bb4(&uStack_30,&uStack_2c,&local_28,&uStack_32);
      } while (iVar8 != 0);
    }
    else {
      do {
        if ((uStack_2c - local_28 == 4) || (pcVar15[0x233] == '\0')) break;
        iVar8 = FUN_01081bb4(&uStack_30,&uStack_2c,&local_28,&uStack_32);
      } while (iVar8 != 0);
    }
    puStack_54 = &uStack_24;
    iStack_50 = func_0x000807be(0,puStack_54,&local_20);
    uStack_58 = (*(code *)(*(uint *)(pcVar15 + 0x70) & 0xfffffffe))(*(undefined4 *)(pcVar15 + 100));
    func_0x00080082();
    func_0x00080082();
  }
  else {
    iStack_50 = 0;
    uStack_58 = 0;
    puStack_54 = (uint *)0x0;
  }
  iVar8 = func_0x00080082();
  if ((uStack_68 & 0x80000000) != 0) {
    FUN_0106c4e8(3,0x164,0x279,PTR_DAT_010826a0,1,uStack_4c);
    uStack_4c = 0;
    uStack_68 = 0;
  }
  iVar16 = local_20;
  piVar6 = DAT_010826a4;
  if (iStack_50 == 0) {
    uStack_24 = uStack_24 & 0xfffffffc;
    iVar17 = (uStack_24 >> 1) + uStack_24 * 0x138 + local_20;
    if ((*DAT_010826a4 != 0) && (*DAT_010826a8 != 0)) {
      iVar13 = iVar17 - *DAT_010826a4;
      iVar9 = func_0x0000050c(iVar8 - *DAT_010826a8,0x18);
      uVar12 = iVar13 - iVar9;
      if ((uVar12 & 0x80000000) != 0) {
        uVar12 = -uVar12;
      }
      if (500 < (int)uVar12) {
        FUN_0106c4e8(3,0x164,0x290,PTR_DAT_0108286c,4,iVar13,iVar9,iVar17,iVar16);
        FUN_0106c4e8(3,0x164,0x291,PTR_DAT_01082870,2,iVar17,*piVar6);
        FUN_010824c0();
        goto LAB_01082716;
      }
    }
    *DAT_010826a8 = iVar8;
    *piVar6 = iVar17;
    cVar2 = pcVar15[0x3d];
    if (cVar2 != '\0') {
      uVar12 = (uint)CARRY4((uint)*(ushort *)(pcVar15 + 0x5c) * 0x10000,(uint)uStack_32);
      iVar8 = (uint)*(ushort *)(pcVar15 + 0x5c) * 0x10000 + (uint)uStack_32 + 1;
      if (iVar8 == 0) {
        uVar12 = uVar12 + 1;
      }
      uVar10 = func_0x00000588(iVar8,uVar12,uStack_30,0);
      uStack_60 = (uVar10 - uStack_2c) - uStack_58;
      iStack_5c = ((uVar12 - (uStack_2c <= uVar10 ^ 1)) - (int)puStack_54) -
                  (uStack_58 <= uVar10 - uStack_2c ^ 1);
      cVar3 = pcVar15[0x234];
      if (cVar3 == '\0') {
LAB_01082772:
        uVar12 = FUN_010005ac(uStack_4c,uStack_68,cVar2,0);
        uStack_64 = uVar12 >> 0x19 | uStack_68 << 7;
        uVar12 = uVar12 << 7;
      }
      else if (cVar3 == -0x30) {
        if (((*(int *)(pcVar15 + 100) != 0) && (*(uint *)(pcVar15 + 0x74) != 0)) &&
           (iVar8 = (*(code *)(*(uint *)(pcVar15 + 0x74) & 0xfffffffe))(), iVar8 != 0)) {
          if (0 < *DAT_01082874) {
            FUN_0104ba04(PTR_s___s__s__s___s_d_s_01082884,PTR_s_general_01082880,
                         PTR_s__ERR__0108287c,PTR_s_csb_audio_data_sample_cnt_analyz_01082888,
                         PTR_s__010f8ede_0x1b_01082878,iVar8,PTR_s__010f8ede_0x1b_01082878);
          }
          FUN_0107c100(0,0x46,0);
        }
        FUN_010005ac(uStack_4c,uStack_68,cVar2,0);
        uVar12 = func_0x00000588();
        uStack_64 = uStack_68;
      }
      else {
        if (cVar3 == -0x50) goto LAB_01082772;
        uStack_68 = 0;
        uStack_64 = 0;
        uVar12 = uStack_68;
      }
      uStack_68 = uVar12;
      uVar12 = uStack_60 >> 2 | iStack_5c * 0x40000000;
      uStack_1c = uStack_68 - uVar12;
      uStack_18 = (uStack_64 - (iStack_5c >> 2)) - (uVar12 <= uStack_68 ^ 1);
      if (((int)uStack_18 < 1) && ((uStack_18 != 0 || (uStack_1c < 0x10001)))) {
        if ((uStack_18 & 0x80000000) != 0) {
          if (2 < *DAT_01082c30) {
            FUN_0104ba04(PTR_s___s__s__s___ssample_cnt_negative_01082c34,PTR_s_general_01082c3c,
                         PTR_s__INF__01082c44,PTR_s_csb_audio_data_sample_cnt_analyz_01082c40,
                         PTR_s__010f8ede_0x1b_01082c38,uStack_1c,uStack_4c,uStack_68,
                         PTR_s__010f8ede_0x1b_01082c38);
          }
          goto LAB_01082716;
        }
      }
      else {
        FUN_0106c4e8(3,0x164,0x2c6,PTR_DAT_0108288c,0);
        FUN_0108df4c(&uStack_1c,1,8,0x10,0xffffffff);
        bVar1 = CARRY4(uStack_60,uStack_30 * 0x10000);
        uStack_60 = uStack_60 + uStack_30 * 0x10000;
        iStack_5c = iStack_5c + (uint)bVar1;
        uVar12 = uStack_60 >> 2 | iStack_5c * 0x40000000;
        uStack_1c = uStack_68 - uVar12;
        uStack_18 = (uStack_64 - (iStack_5c >> 2)) - (uVar12 <= uStack_68 ^ 1);
        if ((uStack_18 != 0) || (0x10000 < uStack_1c)) {
          FUN_0106c4e8(1,0x164,0x2cf,PTR_DAT_01082a28,0);
          FUN_0108df4c(&uStack_1c,1,8,0x10,0xffffffff);
          goto LAB_01082716;
        }
        *(short *)(pcVar15 + 0x5c) = *(short *)(pcVar15 + 0x5c) + 1;
      }
      uVar10 = uStack_18;
      uVar12 = uStack_1c;
      if (param_1 != 0xad) {
        iVar8 = iVar17 - *(int *)(pcVar15 + 0x54);
        if ((DAT_01082a2c < iVar8 - 1U) || (uVar4 = *(ushort *)(pcVar15 + 0x5e), uVar4 == 0)) {
          FUN_0106c4e8(2,0x164,0x2f5,PTR_DAT_01082c48,2,iVar8,*(int *)(pcVar15 + 0x54));
          goto LAB_01082716;
        }
        uVar11 = *(uint *)(pcVar15 + 0x58);
        func_0x00000588(uVar11 - uStack_1c,
                        (((int)uVar11 >> 0x1f) - uStack_18) - (uStack_1c <= uVar11 ^ 1),10000,0);
        iStack_50 = FUN_010005ac();
        iStack_50 = iStack_50 - iVar8;
        uVar11 = func_0x0000049c(iVar8 * (uint)uVar4,10000);
        uStack_1c = uVar12 + uVar11;
        uStack_18 = uVar10 + CARRY4(uVar12,uVar11);
      }
      piVar6 = DAT_01082a30;
      iVar16 = *(int *)(pcVar15 + 0x58) - uStack_1c;
      iVar8 = func_0x0000050c(param_2,cVar2);
      uVar7 = func_0x0000050c(((iVar8 * 0x1e0 + uStack_68) - (uStack_60 >> 2)) * 1000,0x30);
      *DAT_01082a34 = uVar7;
      if (3 < *piVar6) {
        FUN_0104ba04(PTR_s___s__s__s___stime__d_cache_time___01082a40,PTR_s_general_01082a3c,
                     PTR_s__DBG__01082a44,PTR_s_csb_audio_data_sample_cnt_analyz_01082a48,
                     PTR_s__010f8ede_0x1b_01082a38,iVar17 - *(int *)(pcVar15 + 0x54),uVar7,
                     PTR_s__010f8ede_0x1b_01082a38);
      }
      if (3 < *piVar6) {
        FUN_0104ba04(PTR_s___s__s__s___sdiff_sample__d_l__u_01082a4c,PTR_s_general_01082a3c,
                     PTR_s__DBG__01082a44,PTR_s_csb_audio_data_sample_cnt_analyz_01082a48,
                     PTR_s__010f8ede_0x1b_01082a38,iVar16,uStack_1c,*(undefined4 *)(pcVar15 + 0x58),
                     PTR_s__010f8ede_0x1b_01082a38);
      }
      *(undefined4 *)(pcVar15 + 0x4c) = *(undefined4 *)(pcVar15 + 0x48);
      *(int *)(pcVar15 + 0x48) = iVar16;
      if ((uStack_2c != uStack_30) && (uStack_30 != local_28)) {
        *(int *)(pcVar15 + 0x50) = iStack_50;
      }
      iVar8 = FUN_01081bfc(pcVar15[0x98],pcVar15[0x99]);
      if (iVar8 != 0) {
        FUN_0104ba04(PTR_s_trigger_time_diff__d_local__d_re_01082a50,
                     iVar17 - *(int *)(pcVar15 + 0x54),iVar17,*(int *)(pcVar15 + 0x54),
                     *(undefined4 *)(pcVar15 + 0x58),uStack_1c,uStack_68,uStack_60,pcVar15[0x3d]);
        if (param_1 == 0xad) {
          uVar5 = *(undefined2 *)(pcVar15 + 0x5e);
          pcVar15[0x99] = '\x01';
          iVar8 = func_0x0000049c(iVar16 * 10000,uVar5);
          iVar8 = iVar8 + *(int *)(pcVar15 + 0x54);
          *(int *)(pcVar15 + 0x9c) = iVar8;
          FUN_0106c4e8(3,0x164,0x338,PTR_DAT_01082c2c,5,iVar16,iVar17,iVar8,uVar5,iVar8 - iVar17);
          if (*(int *)(pcVar15 + 0x60) != 0) {
            FUN_01085950();
          }
          goto LAB_01082716;
        }
        if (iVar16 < 0xc9) {
          pcVar15[0x99] = '\0';
          if (*(int *)(pcVar15 + 0x60) != 0) {
            FUN_0106c4e8(3,0x164,0x354,PTR_DAT_01082c64,0);
            (*(code *)(*(uint *)(pcVar15 + 0x60) & 0xfffffffe))(*(undefined4 *)(pcVar15 + 100));
            FUN_010824d4(pcVar15,2);
          }
        }
        else {
          uVar5 = *(undefined2 *)(pcVar15 + 0x5e);
          pcVar15[0x99] = '\x01';
          iVar8 = func_0x0000049c(iVar16 * 10000,uVar5);
          *(int *)(pcVar15 + 0x9c) = iVar17 + iVar8;
          FUN_0106c4e8(3,0x164,0x349,PTR_DAT_01082c2c,5,iVar16,iVar17,iVar17 + iVar8,uVar5,iVar8);
          if (*(int *)(pcVar15 + 0x60) != 0) {
            FUN_01085950();
          }
        }
      }
      iVar8 = FUN_01090054();
      if (1000 < (uint)(iVar8 - *(int *)(pcVar15 + 0x44))) {
        FUN_0106c4e8(3,0x164,0x362,PTR_DAT_01082c4c,1,*(undefined2 *)(pcVar15 + 0x5e));
        FUN_0106c4e8(3,0x164,0x363,PTR_DAT_01082c50,3,iStack_50,iVar16,pcVar15[0x34]);
        FUN_0106c4e8(3,0x164,0x365,PTR_DAT_01082c54,1,uStack_58);
        uVar7 = FUN_01090054();
        *(undefined4 *)(pcVar15 + 0x44) = uVar7;
      }
      if ((((puStack_54 != (uint *)0x0) || (10000 < uStack_58)) && (iStack_5c < 1)) &&
         ((iStack_5c != 0 || (uStack_60 <= DAT_01082c58)))) {
        FUN_0106c4e8(3,0x164,0x36c,PTR_DAT_01082c5c,2,uStack_60,uStack_58);
        FUN_0106c4e8(3,0x164,0x36d,PTR_DAT_01082c60,0);
        FUN_0107c100(0,0x3d,0);
      }
      goto LAB_01082716;
    }
    uVar7 = 0x29f;
    puVar14 = PTR_DAT_010826ac;
  }
  else {
    uVar7 = 0x286;
    puVar14 = PTR_DAT_010826b0;
  }
  FUN_0106c4e8(3,0x164,uVar7,puVar14,0);
LAB_01082716:
  FUN_0108f974();
  return;
}



/* FUN_01083e44 @ 01083e44 */

void FUN_01083e44(int param_1,short param_2,int param_3)

{
  int *piVar1;
  undefined2 uVar2;
  int iVar3;
  undefined4 uVar4;
  char *pcVar5;
  int iVar6;
  int iVar7;
  int iStack_18;
  
  param_2 = param_2 + -0x11;
  iVar7 = param_1 + 0x11;
  iStack_18 = param_3;
  FUN_01083dd0(iVar7,param_2,*(undefined1 *)(param_1 + 0xb));
  piVar1 = DAT_01083fe4;
  if (iStack_18 - 1U < 0x18) {
    if (iStack_18 - 1U < 3) {
      FUN_0104ba04(PTR_s_fill_frame__d_frame_len__d_01084004,iStack_18,
                   *(undefined1 *)(*DAT_01083fe4 + 0x3d));
      for (; 0 < iStack_18; iStack_18 = iStack_18 + -1) {
        *(undefined1 *)(param_1 + 0x12) = 0;
        FUN_01083dd0(iVar7,*(undefined1 *)(*piVar1 + 0x3d),1);
      }
    }
    iVar3 = func_0x0000049c(iStack_18,*(undefined1 *)(param_1 + 0xb));
    for (iVar6 = 0; iVar6 != iVar3; iVar6 = iVar6 + 1) {
      FUN_01083dd0(iVar7,param_2,*(undefined1 *)(param_1 + 0xb));
    }
  }
  else {
    iVar3 = *DAT_01083fe4;
    uVar4 = FUN_01090054();
    *(undefined4 *)(iVar3 + 0xa0) = uVar4;
  }
  piVar1 = DAT_01083fe4;
  if (((*(byte *)(*DAT_01083fe4 + 0x231) & 0xe) != 0) && (iVar3 = FUN_0105d610(), iVar3 == 0)) {
    iVar3 = *piVar1;
    *(short *)(iVar3 + 0x254) = param_2;
    *(undefined1 *)(iVar3 + 0x235) = 0;
  }
  pcVar5 = (char *)*piVar1;
  if (*pcVar5 == '\x04') {
    if (*(short *)(pcVar5 + 0x228) == 0) {
      *(undefined2 *)(pcVar5 + 0x228) = *(undefined2 *)(param_1 + 1);
    }
    if ((iStack_18 != 0) && (*DAT_01083fe8 != 0)) {
      (*(code *)(*DAT_01083fe8 & 0xfffffffe))(&iStack_18,4);
    }
  }
  if (*(int *)(*piVar1 + 0xa0) == 0) {
    return;
  }
  iVar3 = FUN_01090054();
  iVar6 = *piVar1;
  if ((uint)(iVar3 - *(int *)(iVar6 + 0xa0)) < 0x1f5) {
    return;
  }
  iVar3 = *(int *)(iVar6 + 0x48);
  *(undefined4 *)(iVar6 + 0xa0) = 0;
  if (iVar3 < 0x7d1) {
    *(undefined2 *)(iVar6 + 0xa4) = 0;
  }
  else {
    if (*(char *)(iVar6 + 0x234) == -0x30) {
      uVar2 = func_0x0000049c(iVar3,0x1e0);
    }
    else {
      if (*(char *)(iVar6 + 0x234) != -0x50) goto LAB_01083f1a;
      uVar2 = (undefined2)(iVar3 >> 7);
    }
    *(undefined2 *)(iVar6 + 0xa4) = uVar2;
  }
LAB_01083f1a:
  if ((int)(uint)*(byte *)(param_1 + 0xb) <= (int)*(short *)(iVar6 + 0xa4)) {
    if (2 < *DAT_01083fec) {
      FUN_0104ba04(PTR_s___s__s__s___spacket_loss_adjust___01083ff4,PTR_s_general_01083ff8,
                   PTR_s__INF__01084000,PTR_s_csb_audio_data_save_01083ffc,
                   PTR_s__010f8ede_0x1b_01083ff0,(int)*(short *)(iVar6 + 0xa4),
                   (uint)*(byte *)(param_1 + 0xb),PTR_s__010f8ede_0x1b_01083ff0);
    }
    iVar3 = func_0x0000049c((int)*(short *)(*piVar1 + 0xa4),*(undefined1 *)(param_1 + 0xb));
    for (iVar6 = 0; iVar6 != iVar3; iVar6 = iVar6 + 1) {
      FUN_01083dd0(iVar7,param_2,*(undefined1 *)(param_1 + 0xb));
      *(ushort *)(*piVar1 + 0xa4) = *(short *)(*piVar1 + 0xa4) - (ushort)*(byte *)(param_1 + 0xb);
    }
  }
  return;
}



/* FUN_010804f0 @ 010804f0 */

void FUN_010804f0(void)

{
  int *piVar1;
  int iVar2;
  
  piVar1 = DAT_01080540;
  iVar2 = FUN_01090054();
  if ((uint)(iVar2 - *piVar1) < 0x1f5) {
    FUN_0106c4e8(2,0x165,0x77,PTR_DAT_01080548,0);
  }
  else {
    FUN_0106c4e8(3,0x165,0x6d,PTR_DAT_01080544,0);
    FUN_0107c100(0,0x40,0);
    FUN_010804ac();
    *piVar1 = iVar2;
  }
  return;
}



/* FUN_01090978 @ 01090978 */

void FUN_01090978(void)

{
  FUN_0108d734(*(int *)(DAT_01090988 + 8) + 0x98,PTR_FUN_0109098c);
  return;
}



/* FUN_01090990 @ 01090990 */

void FUN_01090990(void)

{
  FUN_0108d742(*(int *)(DAT_010909a0 + 8) + 0x98,PTR_FUN_010909a4);
  return;
}



/* FUN_0106f6e0 @ 0106f6e0 */

void FUN_0106f6e0(uint param_1)

{
  byte bVar1;
  int *piVar2;
  undefined2 uVar3;
  int iVar4;
  uint uVar5;
  uint uVar6;
  ushort uVar7;
  byte bVar8;
  uint uVar9;
  
  piVar2 = DAT_0106f820;
  bVar1 = *(byte *)(DAT_0106f820 + 7);
  if ((bVar1 & 8) != 0) {
    if ((bVar1 & 1) == 0) {
      *(byte *)((int)DAT_0106f820 + 0x21) = bVar1 & 1;
      *(undefined1 *)(piVar2 + 8) = 10;
      *(undefined1 *)((int)piVar2 + 0x1e) = 0xff;
      *(undefined1 *)((int)piVar2 + 0x1d) = 0;
      iVar4 = FUN_01090054();
      *piVar2 = iVar4;
      *(byte *)(piVar2 + 7) = *(byte *)(piVar2 + 7) | 1;
    }
    else if (param_1 != 0) {
      iVar4 = FUN_01090054();
      if (*(byte *)((int)piVar2 + 0x1d) < param_1) {
        *(char *)((int)piVar2 + 0x1d) = (char)param_1;
      }
      if ((199 < (uint)(iVar4 - *piVar2)) || (99 < param_1)) {
        uVar7 = *(ushort *)(piVar2 + 2);
        bVar1 = *(byte *)((int)piVar2 + 0x1d);
        iVar4 = (uint)bVar1 + piVar2[1];
        bVar8 = *(char *)((int)piVar2 + 0x21) + 1;
        piVar2[1] = iVar4;
        *(byte *)((int)piVar2 + 0x21) = bVar8;
        if ((uint)uVar7 < (uint)bVar1) {
          uVar7 = (ushort)bVar1;
        }
        *(ushort *)(piVar2 + 2) = uVar7;
        if ((99 < param_1) || (*(byte *)(piVar2 + 8) <= bVar8)) {
          uVar5 = func_0x0000049c((uint)(*(byte *)(piVar2 + 8) >> 1) + iVar4);
          uVar9 = uVar5 & 0xffff;
          iVar4 = FUN_01052660();
          if (iVar4 != 0) {
            uVar7 = *(ushort *)(piVar2 + 2);
            uVar6 = FUN_0105265c();
            if (uVar6 < uVar7) {
              uVar3 = FUN_0105265c();
              *(undefined2 *)(piVar2 + 2) = uVar3;
            }
            iVar4 = (uint)*(ushort *)(piVar2 + 2) - (uVar5 & 0xffff);
            if (8 < iVar4) {
              iVar4 = func_0x0000049c(iVar4 * 2,3);
              uVar9 = uVar9 + iVar4 & 0xffff;
            }
          }
          if (uVar9 < param_1) {
            uVar9 = param_1 & 0xffff;
          }
          FUN_0106c4e8(3,0x113,0x2ee,PTR_DAT_0106f824,2,uVar9,(short)piVar2[2]);
          iVar4 = FUN_010525c4();
          if (iVar4 == 0) {
            uVar3 = FUN_0106f520(DAT_0106f82c,DAT_0106f828,uVar9,0);
            *(undefined2 *)((int)piVar2 + 0x22) = uVar3;
          }
          if ((uVar9 != (int)(short)piVar2[9]) && (piVar2[0xc] != 0)) {
            (*(code *)(piVar2[0xc] & 0xfffffffe))(uVar9,*(undefined4 *)piVar2[10]);
          }
          *(short *)(piVar2 + 9) = (short)uVar9;
          *(undefined1 *)((int)piVar2 + 0x21) = 0;
          piVar2[1] = 0;
          *(undefined2 *)(piVar2 + 2) = 0;
        }
        *(undefined1 *)((int)piVar2 + 0x1e) = 0xff;
        *(undefined1 *)((int)piVar2 + 0x1d) = 0;
        iVar4 = FUN_01090054();
        *piVar2 = iVar4;
      }
    }
  }
  return;
}



/* FUN_01008ad0 @ 01008ad0 */

void FUN_01008ad0(int param_1)

{
  undefined1 uVar1;
  undefined1 uVar2;
  int iVar3;
  undefined4 uVar4;
  uint uVar5;
  undefined4 uVar6;
  int iVar7;
  
  iVar3 = FUN_0100653c(PTR_FUN_01008bd4,param_1,0);
  if (iVar3 == 0) {
    FUN_010113a8();
    uVar4 = FUN_01090054();
    iVar3 = DAT_01008bd8;
    if (param_1 == 0) {
      *(undefined2 *)(DAT_01008bd8 + 0xd6) = *(undefined2 *)(DAT_01008bd8 + 0xb4);
    }
    else {
      uVar5 = func_0x0000050c(uVar4,1000);
      if (uVar5 < *(ushort *)(iVar3 + 0xb4)) {
        uVar5 = *(ushort *)(iVar3 + 0xb4) - uVar5;
        *(short *)(iVar3 + 0xd6) = (short)uVar5;
        FUN_0106c4e8(3,0x1d8,0x2d2,DAT_01008bdc,1,uVar5 & 0xffff);
      }
    }
    *(byte *)(iVar3 + 0xd8) = *(byte *)(iVar3 + 0xd8) & 0xfe;
    uVar4 = FUN_01006b88();
    uVar1 = *(undefined1 *)(iVar3 + 0xcb);
    uVar2 = *(undefined1 *)(iVar3 + 0xca);
    uVar6 = FUN_0100bcd4();
    FUN_0104ba04(PTR_s_enter_pair_mode__d__d__d_role__d_01008be0,uVar4,uVar1,uVar2,uVar6);
    FUN_0100d67c(1,1);
    if (((*(short *)(iVar3 + 0xb6) == 0) && (*(char *)(iVar3 + 0xca) != '\x01')) &&
       (iVar7 = FUN_0100bcd4(), iVar7 == 0)) {
      iVar7 = FUN_01006b88();
      if (1 < iVar7) {
        FUN_010084fc();
      }
    }
    else {
      FUN_010084bc();
    }
    if (*(char *)(iVar3 + 0xb7) != '\0') {
      FUN_01006480(0,2,1);
    }
    if (*(char *)(iVar3 + 0xb8) != '\0') {
      FUN_0100833c();
      FUN_01006480(0,0x25,1);
    }
    if (*(byte *)(iVar3 + 0xcb) < *(byte *)(iVar3 + 0xca)) {
      FUN_010089f8();
    }
    else {
      *(byte *)(iVar3 + 0xd8) = *(byte *)(iVar3 + 0xd8) | 1;
    }
  }
  return;
}



/* FUN_010908c4 @ 010908c4 */

void FUN_010908c4(int param_1,undefined4 param_2,undefined4 param_3,int param_4)

{
  undefined4 uVar1;
  
  if (((param_1 != 0) && (*(int *)(param_1 + 0x18) != 0)) ||
     (FUN_0105df80(PTR_s__ttimer______void___0_______ttim_01090918,0xba,
                   PTR_s__010f8ede_0x1b_01090910), param_1 != 0)) {
    if (param_4 == 0) {
      FUN_0105df80(PTR_s_thread_list______void___0__01090914,0xc3,PTR_s__010f8ede_0x1b_01090910);
    }
    uVar1 = FUN_01090054();
    FUN_0108d702(param_4 + 0x98,param_1,param_2,param_3,uVar1);
  }
  return;
}



/* FUN_01019038 @ 01019038 */

int FUN_01019038(undefined4 *param_1)

{
  undefined1 *puVar1;
  int *piVar2;
  int *piVar3;
  int iVar4;
  int iVar5;
  undefined *puVar6;
  int iVar7;
  int iVar8;
  int iVar9;
  undefined *puVar10;
  undefined *puVar11;
  undefined *puVar12;
  undefined4 uVar13;
  int iVar14;
  undefined4 uVar15;
  undefined1 *puVar16;
  undefined *puVar17;
  uint uVar18;
  int iStack_48;
  uint uStack_40;
  int iStack_3c;
  uint uStack_34;
  int iStack_30;
  undefined1 auStack_24 [6];
  undefined1 uStack_1e;
  undefined1 auStack_1c [6];
  undefined1 uStack_16;
  
  puVar6 = PTR_s__010f8ede_0x1b_010191e8;
  piVar2 = DAT_010191e4;
  uVar18 = 0xe0;
  uVar13 = *param_1;
  iVar14 = (int)param_1 + 0x1d;
  uStack_34 = 0;
  do {
    iVar4 = FUN_0106cbd0(uVar18 & 0xff);
    if (iVar4 != 0) {
      if (2 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___sfound_part_file_id___010191f8,PTR_s_general_010191f4,
                     PTR_s__INF__010191f0,PTR_s_ota_app_sugr_get_backup_part_num_010191ec,puVar6,
                     uVar18,puVar6);
      }
      uStack_34 = uStack_34 + 1 & 0xff;
    }
    piVar3 = DAT_010191e4;
    uVar18 = uVar18 + 1;
  } while (uVar18 != 0xe2);
  if (2 < *DAT_010191e4) {
    FUN_0104ba04(PTR_s___s__s__s___s________Enter_Sugr_o_010191fc,PTR_s_general_010191f4,
                 PTR_s__INF__010191f0,PTR_s_ota_app_sugr_upgrade_related_par_01019200,
                 PTR_s__010f8ede_0x1b_010191e8,PTR_s__010f8ede_0x1b_010191e8);
  }
  if (2 < *piVar3) {
    FUN_0104ba04(PTR_s___s__s__s___sbackup_part_num_____01019204,PTR_s_general_010191f4,
                 PTR_s__INF__010191f0,PTR_s_ota_app_sugr_upgrade_related_par_01019200,
                 PTR_s__010f8ede_0x1b_010191e8,uStack_34,PTR_s__010f8ede_0x1b_010191e8);
  }
  iStack_30 = 0;
  FUN_01018ea4(iVar14,1);
  puVar6 = PTR_s__010f8ede_0x1b_010191e8;
  uStack_40 = 0;
LAB_010190ce:
  if (uStack_40 != uStack_34) {
    iVar4 = FUN_01090054();
    uVar18 = uStack_40 - 0x20 & 0xff;
    iVar5 = FUN_0106cbd0(uVar18);
    if (iVar5 != 0) {
      func_0x000800aa(auStack_1c,iVar5,7);
      uStack_16 = 0;
      puVar1 = *(undefined1 **)(iVar5 + 0x10);
      if (2 < *piVar3) {
        FUN_0104ba04(PTR_s___s__s__s___sbackup_part___s_typ_010195c0,PTR_s_general_010195a8,
                     PTR_s__INF__010195c4,PTR_s_ota_app_sugr_find_related_part_010195c8,puVar6,
                     auStack_1c,*(undefined1 *)(iVar5 + 8),*(undefined1 *)(iVar5 + 9),
                     *(undefined4 *)(iVar5 + 0xc),puVar1,*(byte *)(iVar5 + 10) >> 4,puVar6);
      }
      uVar18 = 0;
      do {
        iVar9 = FUN_01018c18(uVar18 & 0xff);
        if ((iVar9 == 0) || ((*(byte *)(iVar9 + 10) & 0xf0) != 0)) {
          if (1 < *piVar3) {
            puVar16 = (undefined1 *)(uint)(*(byte *)(iVar9 + 10) >> 4);
            puVar10 = PTR_s___s__s__s___spart__d__mismatch_i_010195d0;
            puVar11 = PTR_s_general_010195a8;
            puVar12 = PTR_s__WRN__010195cc;
            puVar17 = PTR_s_ota_app_sugr_find_related_part_010195c8;
            goto LAB_01019584;
          }
        }
        else {
          puVar16 = *(undefined1 **)(iVar9 + 0x10);
          puVar11 = PTR_s_general_010191f4;
          puVar12 = PTR_s__WRN__01019218;
          puVar17 = PTR_s_ota_app_sugr_find_related_part_0101921c;
          if (puVar1 == puVar16) {
            if (*(byte *)(iVar9 + 10) == 0xf) {
              func_0x000800aa(auStack_24,iVar9,7);
              uStack_1e = 0;
              iVar7 = func_0x000800b6(auStack_24,auStack_1c,7);
              if (iVar7 == 0) goto LAB_010195fc;
              if (1 < *piVar3) {
                puVar16 = auStack_24;
                puVar10 = PTR_s___s__s__s___spart__d__mismatch_i_01019228;
                puVar11 = PTR_s_general_010191f4;
                puVar12 = PTR_s__WRN__01019218;
                puVar17 = PTR_s_ota_app_sugr_find_related_part_0101921c;
                goto LAB_01019584;
              }
            }
            else if (1 < *piVar3) {
              puVar16 = (undefined1 *)(*(byte *)(iVar9 + 10) & 0xf);
              puVar10 = PTR_s___s__s__s___spart__d__mismatch_i_01019224;
LAB_01019584:
              FUN_0104ba04(puVar10,puVar11,puVar12,puVar17,puVar6,uVar18,puVar16,puVar6);
            }
          }
          else {
            puVar10 = PTR_s___s__s__s___spart__d__mismatch_i_01019220;
            if (1 < *piVar3) goto LAB_01019584;
          }
        }
        uVar18 = uVar18 + 1;
        if (uVar18 == 0xf) {
          if (0 < *piVar3) {
            FUN_0104ba04(PTR_s___s__s__s___scannot_find_related_010195d4,PTR_s_general_010195a8,
                         PTR_s__ERR__010195b4,PTR_s_ota_app_sugr_find_related_part_01019698,
                         PTR_s__010f8ede_0x1b_010195a4,PTR_s__010f8ede_0x1b_010195a4);
          }
          puVar6 = PTR_s___s__s__s___scannot_found_relate_010196a4;
          puVar10 = PTR_s_general_010196a0;
          puVar11 = PTR_s__ERR__010196a8;
          puVar12 = PTR_s_ota_app_sugr_upgrade_related_par_010196ac;
          puVar17 = PTR_s__010f8ede_0x1b_0101969c;
          if (*piVar3 < 1) goto LAB_0101967c;
          goto LAB_01019128;
        }
      } while( true );
    }
    if (0 < *piVar3) {
      FUN_0104ba04(PTR_s___s__s__s___scannot_found_part_e_0101920c,PTR_s_general_010191f4,
                   PTR_s__ERR__01019208,PTR_s_ota_app_sugr_get_backup_part_01019210,
                   PTR_s__010f8ede_0x1b_010191e8,uVar18,PTR_s__010f8ede_0x1b_010191e8);
    }
    iVar14 = *piVar3;
    puVar6 = PTR_s___s__s__s___scannot_found_backup_01019214;
    goto joined_r0x01019678;
  }
LAB_01019680:
  if (param_1[2] != 0) {
    FUN_0105a260();
    param_1[2] = 0;
  }
  return iStack_30;
LAB_010195fc:
  if (2 < *piVar3) {
    FUN_0104ba04(PTR_s___s__s__s___sfind_related_part___010196b0,PTR_s_general_010196a0,
                 PTR_s__INF__010196b4,PTR_s_ota_app_sugr_find_related_part_01019698,puVar6,
                 uVar18 & 0xff,auStack_24,*(undefined1 *)(iVar9 + 8),*(undefined1 *)(iVar9 + 9),
                 *(undefined4 *)(iVar9 + 0xc),*(undefined4 *)(iVar9 + 0x10),
                 *(byte *)(iVar9 + 10) >> 4,puVar6);
  }
  FUN_01018d5c(iVar14,iVar9,1,0,0);
  iVar7 = FUN_01018c64(uVar13,iVar9);
  if (iVar7 != 0) {
    iVar14 = *piVar3;
    puVar6 = PTR_s___s__s__s___scannot_erase_relate_0101922c;
joined_r0x01019678:
    puVar10 = PTR_s_general_010191f4;
    puVar11 = PTR_s__ERR__01019208;
    puVar12 = PTR_s_ota_app_sugr_upgrade_related_par_01019200;
    puVar17 = PTR_s__010f8ede_0x1b_010191e8;
    if (0 < iVar14) {
LAB_01019128:
      FUN_0104ba04(puVar6,puVar10,puVar11,puVar12,puVar17,uStack_40 + 0xe0,puVar17);
    }
LAB_0101967c:
    iStack_30 = -0x16;
    goto LAB_01019680;
  }
  if (param_1[2] == 0) {
    iVar7 = FUN_0105a24c(param_1[1]);
    param_1[2] = iVar7;
    if (iVar7 == 0) {
      if (0 < *piVar3) {
        FUN_0104ba04(PTR_s___s__s__s___sfaield_to_allocate___010193c8,PTR_s_general_010193c4,
                     PTR_s__ERR__010193cc,PTR_s_ota_app_sugr_upgrade_related_par_010193d0,
                     PTR_s__010f8ede_0x1b_010193c0,param_1[1],PTR_s__010f8ede_0x1b_010193c0);
      }
      iStack_30 = -0xc;
      goto LAB_01019680;
    }
  }
  iStack_3c = *(int *)(iVar5 + 0x10);
  iVar7 = param_1[1];
  FUN_01018d5c(iVar14,iVar9,2,0,0);
  if (2 < *piVar3) {
    FUN_0104ba04(PTR_s___s__s__s___swlen____d_seg_size___010193d8,PTR_s_general_010193c4,
                 PTR_s__INF__010193d4,PTR_s_ota_app_sugr_upgrade_related_par_010193d0,puVar6,
                 iStack_3c,iVar7,*(undefined1 *)(iVar5 + 8),puVar6);
  }
  iStack_48 = 0;
  for (; 0 < iStack_3c; iStack_3c = iStack_3c - iVar7) {
    if (iStack_3c < iVar7) {
      iVar7 = iStack_3c;
    }
    iVar8 = FUN_01018940(uVar13,iVar9,iStack_48,iVar7,param_1[2],param_1[1]);
    if (iVar8 != 1) {
      if (0 < *piVar3) {
        FUN_0104ba04(PTR_s___s__s__s___sstorage_is_not_clea_010195ac,PTR_s_general_010195a8,
                     PTR_s__ERR__010195b4,PTR_s_ota_app_sugr_upgrade_related_par_010195b0,
                     PTR_s__010f8ede_0x1b_010195a4,iStack_48,iVar7,PTR_s__010f8ede_0x1b_010195a4);
      }
      goto LAB_0101967c;
    }
    iStack_30 = FUN_010189f0(uVar13,iVar5,iStack_48,param_1[2],iVar7);
    if (iStack_30 != 0) {
      if (0 < *piVar3) {
        FUN_0104ba04(PTR_s___s__s__s___sCannot_read_data_fr_010195b8,PTR_s_general_010195a8,
                     PTR_s__ERR__010195b4,PTR_s_ota_app_sugr_upgrade_related_par_010195b0,
                     PTR_s__010f8ede_0x1b_010195a4,iStack_48,PTR_s__010f8ede_0x1b_010195a4);
      }
      uVar13 = 3;
      uVar15 = 1;
LAB_0101946c:
      FUN_01018d5c(iVar14,iVar9,uVar13,iStack_48,uVar15);
      goto LAB_01019680;
    }
    FUN_01018d5c(iVar14,iVar9,3,iStack_48,0);
    iStack_30 = FUN_01018aa0(uVar13,iVar9,iStack_48,param_1[2],iVar7);
    if (iStack_30 != 0) {
      if (0 < *piVar3) {
        FUN_0104ba04(PTR_s___s__s__s___sstorage_write_faile_010195bc,PTR_s_general_010195a8,
                     PTR_s__ERR__010195b4,PTR_s_ota_app_sugr_upgrade_related_par_010195b0,
                     PTR_s__010f8ede_0x1b_010195a4,iStack_48,PTR_s__010f8ede_0x1b_010195a4);
      }
      uVar13 = 0xe;
      uVar15 = 0;
      goto LAB_0101946c;
    }
    iStack_48 = iStack_48 + iVar7;
  }
  FUN_01018d5c(iVar14,iVar9,4,0,0);
  uVar15 = param_1[2];
  iVar8 = FUN_01018b50(uVar13,iVar9,uVar15,iVar7);
  iVar7 = FUN_01018b50(uVar13,iVar5,uVar15,iVar7);
  if (2 < *piVar3) {
    FUN_0104ba04(PTR_s___s__s__s___scheck_file__s__crc__010193dc,PTR_s_general_010193c4,
                 PTR_s__INF__010193d4,PTR_s_ota_app_sugr_verify_part_010193e0,puVar6,iVar5,iVar7,
                 iVar9,iVar8,puVar6);
  }
  iStack_30 = 0;
  if (iVar8 != iVar7) {
    if (0 < *piVar3) {
      FUN_0104ba04(PTR_s___s__s__s___sfile__s__verify_fai_010193e4,PTR_s_general_010193c4,
                   PTR_s__ERR__010193cc,PTR_s_ota_app_sugr_upgrade_related_par_010193d0,puVar6,iVar9
                   ,puVar6);
    }
    FUN_01018d5c(iVar14,iVar9,0xf,0,0);
    iStack_30 = -1;
  }
  FUN_01018d5c(iVar14,iVar9,5,0,0);
  iVar5 = FUN_01090054();
  if (2 < *piVar3) {
    uVar18 = *(uint *)(iVar9 + 0x10);
    puVar10 = puVar6;
    uVar15 = func_0x0000050c(uVar18,iVar5 - iVar4);
    FUN_0104ba04(PTR_s___s__s__s___swrite_part__s__leng_010193e8,PTR_s_general_010193c4,
                 PTR_s__INF__010193d4,PTR_s_ota_app_sugr_upgrade_related_par_010193d0,puVar6,iVar9,
                 uVar18 >> 10,iVar5 - iVar4,uVar15,puVar10);
  }
  FUN_0108fad8(10);
  uStack_40 = uStack_40 + 1 & 0xff;
  goto LAB_010190ce;
}



/* FUN_01019880 @ 01019880 */

int FUN_01019880(int *param_1,int *param_2)

{
  undefined *puVar1;
  undefined *puVar2;
  undefined *puVar3;
  undefined *puVar4;
  undefined *puVar5;
  int *piVar6;
  int iVar7;
  uint uVar8;
  int iVar9;
  int iVar10;
  undefined4 uVar11;
  int iVar12;
  int iVar13;
  int iVar14;
  int iVar15;
  int iVar16;
  undefined4 uVar17;
  uint uStack_3c;
  int iStack_2c;
  char cStack_16;
  undefined1 uStack_15;
  
  piVar6 = DAT_01019a0c;
  iVar12 = (int)param_1 + 0x1d;
  if (2 < *DAT_01019a0c) {
    FUN_0104ba04(PTR_s___s__s__s___sEnter_ig_device_ota_01019a1c,PTR_s_general_01019a18,
                 PTR_s__INF__01019a14,PTR_s_ota_app_sugr_igo_ota_01019a20,
                 PTR_s__010f8ede_0x1b_01019a10,PTR_s__010f8ede_0x1b_01019a10);
  }
  if (param_2[1] != 0) {
    param_1[4] = *param_2;
    param_1[5] = param_2[1];
    FUN_01018ea4((int)param_1 + 0x1d,2);
    iVar7 = FUN_0106cbd0(0xb);
    if ((iVar7 != 0) && (*(char *)(iVar7 + 8) == '\x06')) {
      if (param_1[2] == 0) {
        iVar16 = FUN_0105a24c(param_1[1]);
        param_1[2] = iVar16;
        if (iVar16 == 0) {
          if (0 < *piVar6) {
            FUN_0104ba04(PTR_s___s__s__s___sfaield_to_allocate___01019d9c,PTR_s_general_01019d84,
                         PTR_s__ERR__01019d80,PTR_s_ota_app_sugr_igo_ota_01019d94,
                         PTR_s__010f8ede_0x1b_01019d74,param_1[1],PTR_s__010f8ede_0x1b_01019d74);
          }
          iVar16 = -0xc;
          goto LAB_010198b2;
        }
      }
      iVar16 = *param_1;
      if (iVar16 == 0) {
LAB_01019b06:
        if (1 < *piVar6) {
          FUN_0104ba04(PTR_s___s__s__s___sigo_d_version_is_sa_01019c04,PTR_s_general_01019be0,
                       PTR_s__WRN__01019bfc,PTR_s_ota_app_sugr_igo_ota_01019c00,
                       PTR_s__010f8ede_0x1b_01019bd8,0,PTR_s__010f8ede_0x1b_01019bd8);
        }
        iVar16 = 0;
        goto LAB_010198b2;
      }
      cStack_16 = '\0';
      uVar8 = FUN_01021624(0xf,&cStack_16);
      if ((uVar8 == 0) && (cStack_16 == '\x05')) {
        if (2 < *piVar6) {
          FUN_0104ba04(PTR_s___s__s__s___sGet_ig_device_fw_ve_01019a44,PTR_s_general_01019a18,
                       PTR_s__INF__01019a14,PTR_s_ota_app_sugr_igo_fw_ver_get_01019a48,
                       PTR_s__010f8ede_0x1b_01019a10,PTR_s__010f8ede_0x1b_01019a10);
        }
        uStack_15 = 3;
        iVar13 = FUN_010289ec(2,&uStack_15);
        if (iVar13 == 0) {
          iVar13 = FUN_01029a2a();
          if (2 < *piVar6) {
            FUN_0104ba04(PTR_s___s__s__s___scurrent_chip_FW_ver_01019be4,PTR_s_general_01019be0,
                         PTR_s__INF__01019bdc,PTR_s_ota_app_sugr_igo_fw_ver_get_01019be8,
                         PTR_s__010f8ede_0x1b_01019bd8,iVar13,PTR_s__010f8ede_0x1b_01019bd8);
          }
        }
        else {
          iVar13 = 0;
        }
        uStack_15 = 1;
        uVar8 = FUN_010289ec(2,&uStack_15);
        FUN_0108fad8(0x32);
        if (uVar8 != 0) {
          iVar16 = *piVar6;
          puVar1 = PTR_s__010f8ede_0x1b_01019bd8;
          puVar2 = PTR_s_general_01019be0;
          puVar3 = PTR_s__ERR__01019bec;
          puVar4 = PTR_s___s__s__s___sig_get_curfw_err__s_01019bf0;
          puVar5 = PTR_s_ota_app_sugr_igo_is_need_ota_01019bf4;
          goto joined_r0x0101994c;
        }
        if ((iVar13 != 0) &&
           (iVar16 = FUN_010189f0(iVar16,iVar7,0x1000,param_1[2],0x200), iVar16 == 0)) {
          iVar16 = *(int *)(param_1[2] + 0x14);
          if (2 < *piVar6) {
            FUN_0104ba04(PTR_s___s__s__s___sNewfw____08X__s_01019bf8,PTR_s_general_01019be0,
                         PTR_s__INF__01019bdc,PTR_s_ota_app_sugr_igo_is_need_ota_01019bf4,
                         PTR_s__010f8ede_0x1b_01019bd8,iVar16,PTR_s__010f8ede_0x1b_01019bd8);
          }
          if (iVar13 == iVar16) goto LAB_01019b06;
        }
      }
      else {
        iVar16 = *piVar6;
        puVar1 = PTR_s__010f8ede_0x1b_01019a10;
        puVar2 = PTR_s_general_01019a18;
        puVar3 = PTR_s__ERR__01019a24;
        puVar4 = PTR_s___s__s__s___sdsp_status_err__exi_01019a38;
        puVar5 = PTR_s_ota_app_sugr_igo_is_need_ota_01019a3c;
joined_r0x0101994c:
        if (0 < iVar16) {
          FUN_0104ba04(puVar4,puVar2,puVar3,puVar5,puVar1,puVar1);
        }
        if ((uVar8 & 0x80000000) != 0) goto LAB_01019b06;
      }
      FUN_01018d5c((int)param_1 + 0x1d,iVar7,1,0,0);
      if (2 < *piVar6) {
        FUN_0104ba04(PTR_s___s__s__s___sigo_ota_chip___s__s_01019a40,PTR_s_general_01019a18,
                     PTR_s__INF__01019a14,PTR_s_ota_app_sugr_igo_ota_01019a20,
                     PTR_s__010f8ede_0x1b_01019a10,PTR_s_downlink_01019a30,
                     PTR_s__010f8ede_0x1b_01019a10);
      }
      uStack_15 = 3;
      iVar16 = FUN_010289ec(2,&uStack_15);
      if (iVar16 == 0) {
        *(undefined1 *)(param_1 + 3) = 0;
        iVar13 = *param_1;
        iVar14 = param_1[1];
        uStack_3c = *(uint *)(iVar7 + 0x10);
        uVar8 = param_1[5];
        if ((uVar8 != 0) && (uVar8 <= uStack_3c)) {
          uStack_3c = uVar8;
        }
        iVar9 = FUN_01090054();
        if (uStack_3c == 0) {
LAB_010199ea:
          iVar16 = -1;
        }
        else {
          iVar10 = func_0x0000049c(uStack_3c,iVar14);
          iVar16 = func_0x000005cc(uStack_3c,iVar14);
          if (0 < iVar16) {
            iVar10 = iVar10 + 1;
          }
          if (2 < *piVar6) {
            FUN_0104ba04(PTR_s___s__s__s___sigo_fw_size__d__par_01019c08,PTR_s_general_01019be0,
                         PTR_s__INF__01019bdc,PTR_s_ota_app_sugr_ig_updateFW_partial_01019c0c,
                         PTR_s__010f8ede_0x1b_01019bd8,uStack_3c,iVar10,
                         PTR_s__010f8ede_0x1b_01019bd8);
          }
          iVar16 = FUN_0102964c(0);
          if (iVar16 == 0) goto LAB_010199ea;
          FUN_01018d5c((int)param_1 + 0x1d,iVar7,2,0,0);
          puVar2 = PTR_s_ota_app_sugr_ig_updateFW_partial_01019c0c;
          puVar1 = PTR_s__010f8ede_0x1b_01019bd8;
          iVar16 = -1;
          iVar15 = 0;
          for (iStack_2c = 0; iVar10 != iStack_2c; iStack_2c = iStack_2c + 1) {
            if (2 < *piVar6) {
              FUN_0104ba04(PTR_s___s__s__s___sigo_chip_batch_fota_01019c14,PTR_s_general_01019be0,
                           PTR_s__INF__01019bdc,puVar2,puVar1,iVar15,puVar1);
            }
            iVar16 = FUN_010189f0(iVar13,iVar7,iVar15,param_1[2],iVar14);
            if (iVar16 != 0) {
              if (0 < *piVar6) {
                FUN_0104ba04(PTR_s___s__s__s___sCannot_read_data_fr_01019d78,PTR_s_general_01019d84,
                             PTR_s__ERR__01019d80,PTR_s_ota_app_sugr_ig_updateFW_partial_01019d7c,
                             PTR_s__010f8ede_0x1b_01019d74,*(undefined4 *)(iVar7 + 0xc),iVar15,
                             PTR_s__010f8ede_0x1b_01019d74);
              }
              uVar11 = 3;
              uVar17 = 1;
              goto LAB_01019c6e;
            }
            FUN_01018d5c(iVar12,iVar7,3,iVar15,0);
            iVar16 = FUN_01029734(0,iVar15,param_1[2],uStack_3c);
            if (iVar16 != 0) {
              if (0 < *piVar6) {
                FUN_0104ba04(PTR_s___s__s__s___spartial_FOTA_fail___01019d98,PTR_s_general_01019d84,
                             PTR_s__ERR__01019d80,PTR_s_ota_app_sugr_ig_updateFW_partial_01019d7c,
                             PTR_s__010f8ede_0x1b_01019d74,iVar15,PTR_s__010f8ede_0x1b_01019d74);
              }
              uVar11 = 0xe;
              uVar17 = 0;
              goto LAB_01019c6e;
            }
            iVar16 = 0;
            iVar15 = iVar14 + iVar15;
          }
          if (iVar16 != 0) goto LAB_010199ea;
          if (2 < *piVar6) {
            FUN_0104ba04(PTR_s___s__s__s___sigo_chip_partial_do_01019c10,PTR_s_general_01019be0,
                         PTR_s__INF__01019bdc,PTR_s_ota_app_sugr_ig_updateFW_partial_01019c0c,
                         PTR_s__010f8ede_0x1b_01019bd8,PTR_s__010f8ede_0x1b_01019bd8);
          }
          iVar15 = 0;
          uVar11 = 4;
          uVar17 = 0;
          iVar16 = 0;
LAB_01019c6e:
          FUN_01018d5c(iVar12,iVar7,uVar11,iVar15,uVar17);
        }
        iVar13 = FUN_01090054();
        uVar11 = func_0x0000050c(iVar13 - iVar9,1000);
        FUN_0103c5fc(PTR_s__IGO__INFO__TestCase_UpdateFW_Pa_01019d88,uVar11);
      }
      uStack_15 = 0;
      iVar13 = FUN_010289ec(2,&uStack_15);
      if (iVar13 != 0) {
        iVar16 = -1;
      }
      FUN_0108fad8(0x32);
      if (iVar16 == 0) {
        FUN_01018d5c(iVar12,iVar7,5,0,0);
      }
      else if (0 < *piVar6) {
        FUN_0104ba04(PTR_s___s__s__s___sigo__s_ota_fail___s_01019d90,PTR_s_general_01019d84,
                     PTR_s__ERR__01019d80,PTR_s_ota_app_sugr_igo_ota_01019d94,
                     PTR_s__010f8ede_0x1b_01019d74,PTR_s_downlink_01019d8c,
                     PTR_s__010f8ede_0x1b_01019d74);
      }
      goto LAB_010198b2;
    }
    if (0 < *piVar6) {
      FUN_0104ba04(PTR_s___s__s__s___sCannot_found_ig_par_01019a28,PTR_s_general_01019a18,
                   PTR_s__ERR__01019a24,PTR_s_partition_get_ig_part_01019a2c,
                   PTR_s__010f8ede_0x1b_01019a10,PTR_s__010f8ede_0x1b_01019a10);
    }
    if (0 < *piVar6) {
      FUN_0104ba04(PTR_s___s__s__s___sCannot_find_ig_part_01019a34,PTR_s_general_01019a18,
                   PTR_s__ERR__01019a24,PTR_s_ota_app_sugr_igo_ota_01019a20,
                   PTR_s__010f8ede_0x1b_01019a10,PTR_s_downlink_01019a30,
                   PTR_s__010f8ede_0x1b_01019a10);
    }
  }
  iVar16 = -0x16;
LAB_010198b2:
  if (param_1[2] != 0) {
    FUN_0105a260();
    param_1[2] = 0;
  }
  return iVar16;
}



/* FUN_01019de0 @ 01019de0 */

int FUN_01019de0(int *param_1,int param_2)

{
  int *piVar1;
  undefined *puVar2;
  int iVar3;
  int iVar4;
  undefined4 uVar5;
  int iVar6;
  int iVar7;
  uint uVar8;
  int iVar9;
  undefined4 uVar10;
  undefined *puVar11;
  uint uStack_48;
  uint uStack_44;
  uint uStack_40;
  uint uStack_38;
  int iStack_30;
  int iStack_2c;
  int iStack_1c;
  int iStack_18;
  
  piVar1 = DAT_01019f7c;
  iStack_1c = 0;
  if (2 < *DAT_01019f7c) {
    FUN_0104ba04(PTR_s___s__s__s___sEnter_uac_device_ot_01019f8c,PTR_s_general_01019f88,
                 PTR_s__INF__01019f84,PTR_s_ota_app_sugr_uac_ota_01019f90,
                 PTR_s__010f8ede_0x1b_01019f80,PTR_s__010f8ede_0x1b_01019f80);
  }
  if (param_2 != 0) {
    iVar6 = (int)param_1 + 0x1d;
    param_1[6] = param_2;
    FUN_01018ea4(iVar6,4);
    iVar3 = FUN_0106cbd0(9);
    if ((iVar3 != 0) && (*(char *)(iVar3 + 8) == '\x06')) {
      if (param_1[2] == 0) {
        iVar9 = FUN_0105a24c(param_1[1]);
        param_1[2] = iVar9;
        if (iVar9 == 0) {
          if (0 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___sfaield_to_allocate___0101a510,PTR_s_general_0101a4e8,
                         PTR_s__ERR__0101a4f0,PTR_s_ota_app_sugr_uac_ota_0101a50c,
                         PTR_s__010f8ede_0x1b_0101a4e4,param_1[1],PTR_s__010f8ede_0x1b_0101a4e4);
          }
          iVar9 = -0xc;
          goto LAB_01019e0e;
        }
      }
      iStack_1c = 0xf;
      FUN_01022c88(1,&iStack_1c);
      FUN_0108fad8(10);
      iVar9 = FUN_01023f00(1,&iStack_1c);
      if ((iVar9 == 0) || (iStack_1c != 0)) {
        iVar9 = *param_1;
        iStack_18 = 0;
        if (iVar9 == 0) {
LAB_0101a25a:
          if (2 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___suac_version_is_same_0101a340,PTR_s_general_0101a31c,
                         PTR_s__INF__0101a318,PTR_s_ota_app_sugr_uac_ota_0101a344,
                         PTR_s__010f8ede_0x1b_0101a328,PTR_s__010f8ede_0x1b_0101a328);
          }
          iVar9 = 0;
          goto LAB_01019e0e;
        }
        if ((char)param_1[7] == '\x01') {
          if (2 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___s_Skip_the_version_c_01019fa8,PTR_s_general_01019f88,
                         PTR_s__INF__01019f84,PTR_s_ota_app_sugr_uac_is_need_ota_01019fac,
                         PTR_s__010f8ede_0x1b_01019f80,PTR_s__010f8ede_0x1b_01019f80);
          }
          *(undefined1 *)(param_1 + 7) = 0;
        }
        else {
          iVar7 = FUN_01024174(0x3e0,&iStack_18,4,1000);
          if (iVar7 == 0) {
            if ((iStack_18 - 1U < 0xfffffffe) &&
               (iVar9 = FUN_010189f0(iVar9,iVar3,0x200,param_1[2],0x200), iVar9 == 0)) {
              iVar9 = *(int *)(param_1[2] + 0x1e0);
              if (2 < *piVar1) {
                FUN_0104ba04(PTR_s___s__s__s___sNewVer__0x_08X_CurV_0101a33c,PTR_s_general_0101a31c,
                             PTR_s__INF__0101a318,PTR_s_ota_app_sugr_uac_is_need_ota_0101a338,
                             PTR_s__010f8ede_0x1b_0101a328,iVar9,iStack_18,
                             PTR_s__010f8ede_0x1b_0101a328);
              }
              if (iStack_18 == iVar9) goto LAB_0101a25a;
            }
          }
          else if (0 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___suac_get_curfw_err___0101a334,PTR_s_general_0101a31c,
                         PTR_s__ERR__0101a330,PTR_s_ota_app_sugr_uac_is_need_ota_0101a338,
                         PTR_s__010f8ede_0x1b_0101a328,PTR_s__010f8ede_0x1b_0101a328);
          }
        }
        iVar7 = *param_1;
        uStack_40 = param_1[1];
        FUN_01018d5c((int)param_1 + 0x1d,iVar3,1,0,0);
        uStack_48 = *(uint *)(iVar3 + 0x10);
        uVar8 = param_1[6];
        if ((uVar8 != 0) && (uVar8 <= uStack_48)) {
          uStack_48 = uVar8;
        }
        iVar4 = FUN_01090054();
        if (uStack_48 == 0) {
          iVar9 = -1;
        }
        else {
          FUN_01018d5c((int)param_1 + 0x1d,iVar3,2,0,0);
          if (2 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___seeprom_addr_0x_0x_b_01019fb0,PTR_s_general_01019f88,
                         PTR_s__INF__01019f84,PTR_s_ota_app_sugr_uac_updateFW_01019fb4,
                         PTR_s__010f8ede_0x1b_01019f80,0,uStack_40,uStack_48,
                         PTR_s__010f8ede_0x1b_01019f80);
          }
          puVar11 = PTR_s_ota_app_sugr_uac_updateFW_0101a150;
          puVar2 = PTR_s__010f8ede_0x1b_0101a14c;
          uStack_44 = 0;
          iVar9 = -1;
          for (; 0 < (int)uStack_48; uStack_48 = uStack_48 - uStack_40) {
            if ((int)uStack_48 < (int)uStack_40) {
              uStack_40 = uStack_48;
            }
            if (2 < *piVar1) {
              FUN_0104ba04(PTR_s___s__s__s___suac_device_ota_proc_0101a348,PTR_s_general_0101a31c,
                           PTR_s__INF__0101a318,puVar11,puVar2,uStack_44,puVar2);
            }
            iVar9 = FUN_010189f0(iVar7,iVar3,uStack_44,param_1[2],uStack_40);
            if (iVar9 != 0) {
              if (0 < *piVar1) {
                FUN_0104ba04(PTR_s___s__s__s___sCannot_read_data_fr_0101a34c,PTR_s_general_0101a31c,
                             PTR_s__ERR__0101a330,PTR_s_ota_app_sugr_uac_updateFW_0101a350,
                             PTR_s__010f8ede_0x1b_0101a328,*(undefined4 *)(iVar3 + 0xc),uStack_44,
                             PTR_s__010f8ede_0x1b_0101a328);
              }
              uVar5 = 3;
              uVar10 = 1;
LAB_0101a2f2:
              FUN_01018d5c(iVar6,iVar3,uVar5,uStack_44,uVar10);
              goto LAB_0101a2fa;
            }
            FUN_01018d5c(iVar6,iVar3,3,uStack_44,0);
            iVar9 = FUN_01023fbc(uStack_44 & 0xffff,param_1[2],uStack_40 & 0xffff,30000);
            if (iVar9 != 0) {
              if (0 < *piVar1) {
                FUN_0104ba04(PTR_s___s__s__s___sError_write_to_uac__0101a4ec,PTR_s_general_0101a4e8,
                             PTR_s__ERR__0101a4f0,PTR_s_ota_app_sugr_uac_updateFW_0101a4f4,
                             PTR_s__010f8ede_0x1b_0101a4e4,uStack_44,PTR_s__010f8ede_0x1b_0101a4e4);
              }
              uVar5 = 0xe;
              uVar10 = 0;
              goto LAB_0101a2f2;
            }
            uStack_44 = uStack_44 + uStack_40;
          }
          if (2 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___suac_dev_eeprom_writ_0101a15c,PTR_s_general_0101a158,
                         PTR_s__INF__0101a154,PTR_s_ota_app_sugr_uac_updateFW_0101a150,
                         PTR_s__010f8ede_0x1b_0101a14c,PTR_s__010f8ede_0x1b_0101a14c);
          }
          FUN_01018d5c(iVar6,iVar3,4,0,0);
        }
        iVar7 = FUN_01090054();
        puVar2 = PTR_s__010f8ede_0x1b_0101a14c;
        if (2 < *piVar1) {
          puVar11 = PTR_s__010f8ede_0x1b_0101a14c;
          uVar5 = func_0x0000050c(iVar7 - iVar4,1000);
          FUN_0104ba04(PTR_s___s__s__s___suac_dev_eeprom_writ_0101a160,PTR_s_general_0101a158,
                       PTR_s__INF__0101a154,PTR_s_ota_app_sugr_uac_updateFW_0101a150,puVar2,uVar5,
                       puVar11);
        }
        FUN_0108fad8(10);
        if (iVar9 != 0) {
LAB_0101a2fa:
          if (0 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___sfile__s__update_fai_0101a354,PTR_s_general_0101a31c,
                         PTR_s__ERR__0101a330,PTR_s_ota_app_sugr_uac_ota_0101a344,
                         PTR_s__010f8ede_0x1b_0101a328,iVar3,PTR_s__010f8ede_0x1b_0101a328);
          }
          goto LAB_01019e0e;
        }
        iVar9 = *param_1;
        uStack_44 = param_1[1];
        uStack_48 = *(uint *)(iVar3 + 0x10);
        uVar8 = param_1[6];
        if ((uVar8 != 0) && (uVar8 <= uStack_48)) {
          uStack_48 = uVar8;
        }
        iVar7 = FUN_01090054();
        iVar4 = param_1[2];
        iStack_30 = *(int *)(iVar3 + 0xc);
        if (2 < *piVar1) {
          FUN_0104ba04(PTR_s___s__s__s___scheck_file__s__addr_0101a164,PTR_s_general_0101a158,
                       PTR_s__INF__0101a154,PTR_s_ota_app_sugr_uac_caculateFW_crc_0101a168,
                       PTR_s__010f8ede_0x1b_0101a14c,iVar3,iStack_30,0,uStack_48,
                       PTR_s__010f8ede_0x1b_0101a14c);
        }
        uVar8 = FUN_01061500(iVar9);
        if (uVar8 != *(byte *)(iVar3 + 10) >> 4) {
          FUN_01061504(iVar9);
        }
        iStack_2c = 0;
        uStack_40 = uStack_44;
        for (uStack_38 = uStack_48; 0 < (int)uStack_38; uStack_38 = uStack_38 - uStack_40) {
          if ((int)uStack_38 < (int)uStack_40) {
            uStack_40 = uStack_38;
          }
          FUN_010615d4(iVar9,iStack_30,iVar4);
          iStack_2c = FUN_0108dd4c(iStack_2c,iVar4,uStack_40);
          iStack_30 = iStack_30 + uStack_40;
        }
        FUN_01061504(iVar9,uVar8 & 0xff);
        if (uStack_48 != 0) {
          if (2 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___seeprom_addr_0x_0x_b_0101a16c,PTR_s_general_0101a158,
                         PTR_s__INF__0101a154,PTR_s_ota_app_sugr_uac_verifyFW_0101a170,
                         PTR_s__010f8ede_0x1b_0101a14c,0,uStack_44,uStack_48,
                         PTR_s__010f8ede_0x1b_0101a14c);
          }
          puVar11 = PTR_s_ota_app_sugr_uac_verifyFW_0101a170;
          puVar2 = PTR_s__010f8ede_0x1b_0101a14c;
          uStack_38 = 0;
          uStack_40 = 0;
          for (; 0 < (int)uStack_48; uStack_48 = uStack_48 - uStack_44) {
            if ((int)uStack_48 < (int)uStack_44) {
              uStack_44 = uStack_48;
            }
            if (2 < *piVar1) {
              FUN_0104ba04(PTR_s___s__s__s___suac_verifyFW___eepr_0101a4fc,PTR_s_general_0101a4e8,
                           PTR_s__INF__0101a4f8,puVar11,puVar2,uStack_40,uStack_44,puVar2);
            }
            iVar9 = FUN_01024174(uStack_40 & 0xffff,param_1[2],uStack_44 & 0xffff,30000);
            if (iVar9 != 0) {
              if (*piVar1 < 1) goto LAB_0101a474;
              FUN_0104ba04(PTR_s___s__s__s___sError_read_from_uac_0101a500,PTR_s_general_0101a4e8,
                           PTR_s__ERR__0101a4f0,PTR_s_ota_app_sugr_uac_verifyFW_0101a504,
                           PTR_s__010f8ede_0x1b_0101a4e4,uStack_40,PTR_s__010f8ede_0x1b_0101a4e4);
              goto LAB_0101a45a;
            }
            uStack_38 = FUN_0108dd4c(uStack_38,param_1[2],uStack_44);
            uStack_40 = uStack_40 + uStack_44;
          }
          if (2 < *piVar1) {
            FUN_0104ba04(PTR_s___s__s__s___scheck_file__s_crc_o_0101a174,PTR_s_general_0101a158,
                         PTR_s__INF__0101a154,PTR_s_ota_app_sugr_uac_verifyFW_0101a170,
                         PTR_s__010f8ede_0x1b_0101a14c,iVar3,iStack_2c,uStack_38,
                         PTR_s__010f8ede_0x1b_0101a14c);
          }
          FUN_0108fad8(10);
          if (uStack_38 == iStack_2c) {
            iVar9 = 0;
            if (2 < *piVar1) {
              FUN_0104ba04(PTR_s___s__s__s___sverify_success_s_0101a320,PTR_s_general_0101a31c,
                           PTR_s__INF__0101a318,PTR_s_ota_app_sugr_uac_verifyFW_0101a324,
                           PTR_s__010f8ede_0x1b_0101a14c,PTR_s__010f8ede_0x1b_0101a14c);
            }
          }
          else {
            iVar9 = -1;
          }
          iVar4 = FUN_01090054();
          puVar2 = PTR_s__010f8ede_0x1b_0101a328;
          if (2 < *piVar1) {
            puVar11 = PTR_s__010f8ede_0x1b_0101a328;
            uVar5 = func_0x0000050c(iVar4 - iVar7,1000);
            FUN_0104ba04(PTR_s___s__s__s___suac_dev_eeprom_veri_0101a32c,PTR_s_general_0101a31c,
                         PTR_s__INF__0101a318,PTR_s_ota_app_sugr_uac_verifyFW_0101a324,puVar2,uVar5,
                         puVar11);
          }
          if (iVar9 == 0) {
            FUN_01018d5c(iVar6,iVar3,5,0,0);
            iVar9 = 0;
            goto LAB_01019e0e;
          }
        }
LAB_0101a45a:
        if (0 < *piVar1) {
          FUN_0104ba04(PTR_s___s__s__s___sfile__s__verify_fai_0101a508,PTR_s_general_0101a4e8,
                       PTR_s__ERR__0101a4f0,PTR_s_ota_app_sugr_uac_ota_0101a50c,
                       PTR_s__010f8ede_0x1b_0101a4e4,iVar3,PTR_s__010f8ede_0x1b_0101a4e4);
        }
LAB_0101a474:
        FUN_01018d5c(iVar6,iVar3,0xf,0,0);
      }
      else if (0 < *piVar1) {
        FUN_0104ba04(PTR_s___s__s__s___sfile__s__uac_dev_is_01019fa4,PTR_s_general_01019f88,
                     PTR_s__ERR__01019f94,PTR_s_ota_app_sugr_uac_ota_01019f90,
                     PTR_s__010f8ede_0x1b_01019f80,iVar3,PTR_s__010f8ede_0x1b_01019f80);
      }
      iVar9 = -1;
      goto LAB_01019e0e;
    }
    if (0 < *piVar1) {
      FUN_0104ba04(PTR_s___s__s__s___sCannot_found_uac_pa_01019f98,PTR_s_general_01019f88,
                   PTR_s__ERR__01019f94,PTR_s_partition_get_uac_part_01019f9c,
                   PTR_s__010f8ede_0x1b_01019f80,PTR_s__010f8ede_0x1b_01019f80);
    }
    if (0 < *piVar1) {
      FUN_0104ba04(PTR_s___s__s__s___sCannot_find_uac_par_01019fa0,PTR_s_general_01019f88,
                   PTR_s__ERR__01019f94,PTR_s_ota_app_sugr_uac_ota_01019f90,
                   PTR_s__010f8ede_0x1b_01019f80,PTR_s__010f8ede_0x1b_01019f80);
    }
  }
  iVar9 = -0x16;
LAB_01019e0e:
  if (param_1[2] != 0) {
    FUN_0105a260();
    param_1[2] = 0;
  }
  if (iVar9 == 0) {
    iStack_1c = 0xf0;
    iVar9 = FUN_01022c88(1,&iStack_1c);
  }
  return iVar9;
}



/* FUN_01023fbc @ 01023fbc */

undefined4 FUN_01023fbc(int param_1,undefined1 *param_2,int param_3,int param_4)

{
  int *piVar1;
  int iVar2;
  int iVar3;
  undefined *puVar4;
  uint uVar5;
  uint uVar6;
  
  iVar2 = FUN_01090054();
  iVar3 = FUN_01021cf0(0x100,1);
  if (iVar3 == 0) {
    uVar6 = iVar2 + param_4;
    while (iVar3 = FUN_01022134(), piVar1 = DAT_0102414c, puVar4 = PTR_s__010f8ede_0x1b_01024148,
          iVar3 == 1) {
      uVar5 = FUN_01090054();
      if (uVar6 < uVar5) {
        return 0xfffffffe;
      }
    }
    for (iVar2 = 0; iVar2 < param_3; iVar2 = iVar2 + 1) {
      uVar5 = param_1 + iVar2;
      iVar3 = FUN_01021cf0(0x110,(int)uVar5 >> 8 & 3U | 0x50);
      if (iVar3 != 0) {
        if (*piVar1 < 1) {
          return 0xffffffff;
        }
        iVar2 = 0x88;
        goto LAB_0102406c;
      }
      iVar3 = FUN_01021cf0(0x14,uVar5 & 0xff);
      if (iVar3 != 0) {
        if (*piVar1 < 1) {
          return 0xffffffff;
        }
        uVar5 = 0x14;
        puVar4 = PTR_s___s__s__s___suac_write_RegAddr_0_0102415c;
        goto LAB_010240bc;
      }
      iVar3 = FUN_01021cf0(0x10,*param_2);
      if (iVar3 != 0) {
        puVar4 = PTR_s___s__s__s___suac_eeprom_read_Reg_01024160;
        if (*piVar1 < 1) {
          return 0xffffffff;
        }
        goto LAB_010240bc;
      }
      if (2 < *piVar1) {
        FUN_0104ba04(PTR_s___s__s__s___suac_eeprom_write_Re_01024168,PTR_s_general_01024158,
                     PTR_s__INF__01024164,PTR_s_uac_dev_eeprom_reg_write_01024154,puVar4,uVar5,
                     *param_2,puVar4);
      }
      while (iVar3 = FUN_01022134(), iVar3 == 1) {
        uVar5 = FUN_01090054();
        if (uVar6 < uVar5) {
          return 0xfffffffe;
        }
      }
      FUN_0108fad8(2);
      iVar3 = FUN_01021cf0(0x15,0x95);
      if (iVar3 != 0) {
        if (*piVar1 < 1) {
          return 0xffffffff;
        }
        uVar5 = 0x15;
        puVar4 = PTR_s___s__s__s___suac_read_RegAddr_0x_0102416c;
        goto LAB_010240bc;
      }
      while (iVar3 = FUN_01022134(), iVar3 == 1) {
        uVar5 = FUN_01090054();
        if (uVar6 < uVar5) {
          return 0xfffffffe;
        }
      }
      param_2 = param_2 + 1;
    }
    iVar3 = FUN_01021cf0(0x100,0);
    if (iVar3 == 0) {
      *(undefined1 *)(*DAT_01024170 + 0x2f) = 0;
      return 0;
    }
    iVar2 = *DAT_0102414c;
  }
  else {
    iVar2 = *DAT_0102414c;
  }
  if (0 < iVar2) {
    iVar2 = 0x80;
LAB_0102406c:
    uVar5 = iVar2 << 1;
    puVar4 = PTR_s___s__s__s___suac_write_RegAddr_0_0102415c;
LAB_010240bc:
    FUN_0104ba04(puVar4,PTR_s_general_01024158,PTR_s__ERR__01024150,
                 PTR_s_uac_dev_eeprom_reg_write_01024154,PTR_s__010f8ede_0x1b_01024148,uVar5,iVar3,
                 PTR_s__010f8ede_0x1b_01024148);
  }
  return 0xffffffff;
}



/* FUN_01024174 @ 01024174 */

undefined4 FUN_01024174(int param_1,int param_2,int param_3,int param_4)

{
  int *piVar1;
  int iVar2;
  int iVar3;
  undefined *puVar4;
  uint uVar5;
  uint uVar6;
  int iVar7;
  undefined1 uStack_15;
  
  iVar2 = FUN_01090054();
  iVar3 = FUN_01021cf0(0x100,1);
  if (iVar3 == 0) {
    while (iVar3 = FUN_01022134(), piVar1 = DAT_010242f0, iVar3 == 1) {
      uVar6 = FUN_01090054();
      if ((uint)(param_4 + iVar2) < uVar6) {
        return 0xfffffffe;
      }
    }
    for (iVar7 = 0; iVar7 < param_3; iVar7 = iVar7 + 1) {
      uVar6 = param_1 + iVar7;
      iVar3 = FUN_01021cf0(0x110,(int)uVar6 >> 8 & 3U | 0x50);
      if (iVar3 != 0) {
        if (*DAT_010242f0 < 1) {
          return 0xffffffff;
        }
        iVar2 = 0x88;
        goto LAB_0102421e;
      }
      iVar3 = FUN_01021cf0(0x14,uVar6 & 0xff);
      if (iVar3 != 0) {
        if (*DAT_010242f0 < 1) {
          return 0xffffffff;
        }
        uVar6 = 0x14;
        puVar4 = PTR_s___s__s__s___suac_write_RegAddr_0_01024304;
        goto LAB_01024274;
      }
      iVar3 = FUN_01021cf0(0x15,0x94);
      if (iVar3 != 0) {
        if (*DAT_010242f0 < 1) {
          return 0xffffffff;
        }
        uVar6 = 0x15;
        puVar4 = PTR_s___s__s__s___suac_read_RegAddr_0x_01024308;
        goto LAB_01024274;
      }
      while (iVar3 = FUN_01022134(), iVar3 == 1) {
        uVar5 = FUN_01090054();
        if ((uint)(param_4 + iVar2) < uVar5) {
          return 0xfffffffe;
        }
      }
      FUN_0108fad8(2);
      iVar3 = FUN_01021ec8(0x10,&uStack_15);
      if (iVar3 != 0) {
        puVar4 = PTR_s___s__s__s___suac_eeprom_read_Reg_0102430c;
        if (*piVar1 < 1) {
          return 0xffffffff;
        }
        goto LAB_01024274;
      }
      *(undefined1 *)(param_2 + iVar7) = uStack_15;
      if (2 < *piVar1) {
        FUN_0104ba04(PTR_s___s__s__s___suac_eeprom_read_Reg_01024310,PTR_s_general_01024300,
                     PTR_s__INF__01024314,PTR_s_uac_dev_eeprom_reg_read_010242fc,
                     PTR_s__010f8ede_0x1b_010242f4,uVar6,uStack_15,PTR_s__010f8ede_0x1b_010242f4);
      }
    }
    iVar3 = FUN_01021cf0(0x100,0);
    if (iVar3 == 0) {
      *(undefined1 *)(*DAT_01024318 + 0x2f) = 0;
      return 0;
    }
    iVar2 = *DAT_010242f0;
  }
  else {
    iVar2 = *DAT_010242f0;
  }
  if (0 < iVar2) {
    iVar2 = 0x80;
LAB_0102421e:
    uVar6 = iVar2 << 1;
    puVar4 = PTR_s___s__s__s___suac_write_RegAddr_0_01024304;
LAB_01024274:
    FUN_0104ba04(puVar4,PTR_s_general_01024300,PTR_s__ERR__010242f8,
                 PTR_s_uac_dev_eeprom_reg_read_010242fc,PTR_s__010f8ede_0x1b_010242f4,uVar6,iVar3,
                 PTR_s__010f8ede_0x1b_010242f4);
  }
  return 0xffffffff;
}



/* FUN_01029a04 @ 01029a04 */

int FUN_01029a04(void)

{
  int iVar1;
  
  iVar1 = FUN_01090054();
  return iVar1 * 1000;
}



/* FUN_01021728 @ 01021728 */

undefined4 FUN_01021728(int param_1,undefined4 param_2,undefined4 param_3,byte param_4)

{
  int iVar1;
  int iVar2;
  int iVar3;
  undefined4 *puVar4;
  undefined4 uVar5;
  
  iVar1 = DAT_010217b8;
  iVar3 = 0;
  do {
    if (*(int *)(iVar3 * 0x10 + DAT_010217b8) == 0) goto LAB_0102174a;
    iVar3 = iVar3 + 1;
  } while (iVar3 != 10);
  iVar3 = -1;
LAB_0102174a:
  iVar2 = FUN_01090054();
  if (iVar3 == -1) {
    uVar5 = 0xffffffff;
    if (0 < *DAT_010217bc) {
      FUN_0104ba04(PTR_s___s__s__s___sERROR__no_callback_s_010217cc,PTR_s_general_010217c8,
                   PTR_s__ERR__010217c4,PTR_s__svz_async_call_010217d0,PTR_s__010f8ede_0x1b_010217c0
                   ,PTR_s__010f8ede_0x1b_010217c0);
    }
  }
  else {
    puVar4 = (undefined4 *)(iVar3 * 0x10 + iVar1);
    *(byte *)(puVar4 + 3) = param_4;
    *puVar4 = param_2;
    puVar4[1] = param_3;
    puVar4[2] = iVar2 + param_1;
    if (((param_4 & 1) != 0) && (2 < *DAT_010217bc)) {
      FUN_0104ba04(PTR_s___s__s__s___scallback_add_T_d__d_010217d8,PTR_s_general_010217c8,
                   PTR_s__INF__010217d4,PTR_s__svz_async_call_010217d0,PTR_s__010f8ede_0x1b_010217c0
                   ,iVar2 + param_1,param_1,PTR_s__010f8ede_0x1b_010217c0);
    }
    uVar5 = 0;
  }
  return uVar5;
}



/* FUN_01042b38 @ 01042b38 */

undefined4 FUN_01042b38(int *param_1,byte *param_2)

{
  byte bVar1;
  undefined4 *puVar2;
  int iVar3;
  uint uVar4;
  undefined4 uVar5;
  uint uVar6;
  undefined4 uVar7;
  undefined4 uVar8;
  int iVar9;
  uint uVar10;
  uint uVar11;
  undefined *puVar12;
  uint *puVar13;
  uint uVar14;
  int iVar15;
  uint *puVar16;
  undefined2 uStack_50;
  ushort uStack_4e;
  undefined2 uStack_4c;
  undefined2 uStack_4a;
  undefined4 uStack_44;
  uint **ppuStack_40;
  uint *apuStack_34 [2];
  uint *puStack_2c;
  uint uStack_20;
  
  uVar4 = *(uint *)(param_2 + 4);
  uVar6 = uVar4 & 0x1f;
  iVar9 = param_1[2];
  if (uVar6 == 7) {
    uVar6 = 2;
LAB_01042b92:
    uVar7 = 0x11;
  }
  else if (uVar6 < 8) {
    if (uVar6 == 0) {
      uVar6 = 0;
      uVar7 = 0;
    }
    else {
      if (uVar6 != 1) {
LAB_01042b5a:
        FUN_0106c4e8(1,0x5e,0x169,PTR_DAT_01042d00,1,uVar6);
        FUN_0106c4e8(2,0x5e,0x252,PTR_DAT_01042d04,0);
        return 0xffffffdd;
      }
      uVar6 = 1;
      uVar7 = 0x10;
    }
  }
  else {
    if (uVar6 != 0x15) {
      if (uVar6 != 0x1d) goto LAB_01042b5a;
      uVar6 = 3;
      goto LAB_01042b92;
    }
    if (*(int *)(param_2 + 0x24) == 0) {
      uVar6 = 1;
    }
    else {
      uVar6 = 4;
      if ((uVar4 & 0x20000) == 0) {
        uVar6 = 5;
      }
    }
    uVar7 = 0x17;
  }
  puVar16 = *(uint **)(param_2 + 0x24);
  uVar6 = (uint)*(byte *)(iVar9 + 0x18) << 0x14 | (uint)*(byte *)(iVar9 + 0x19) << 0x10 | uVar6;
  if (puVar16 != (uint *)0x0) {
    uVar6 = uVar6 | 0x40;
  }
  puVar2 = *(undefined4 **)(*param_1 + 8);
  if ((puVar2[1] & 8) != 0) {
    uVar6 = uVar6 | 0x1000;
  }
  uVar14 = *(uint *)(param_2 + 0x20);
  puVar13 = (uint *)*puVar2;
  puVar13[1] = uVar6;
  puVar13[4] = *(uint *)(param_2 + 8);
  puVar13[3] = (uint)*param_2;
  uVar6 = *(uint *)(param_2 + 0x1c);
  puVar13[0xc] = uVar6;
  puVar13[0xb] = uVar14;
  if (puVar16 == (uint *)0x0) {
    puVar13[1] = puVar13[1] | 0x80;
LAB_01042c04:
    iVar15 = 0;
  }
  else {
    uVar4 = uVar4 & 0x10000;
    uVar14 = uVar6 * uVar14;
    if (((*(uint *)(iVar9 + 0x24) & 0x80000000) == 0) && (((uint)puVar16 & 3) == 0)) {
      func_0x0008009e(&uStack_50,0,0x1c);
      func_0x0008009e(apuStack_34,0,0x20);
      uStack_44 = 1;
      ppuStack_40 = apuStack_34;
      bVar1 = *(byte *)((int)puVar2 + 0x12);
      if (uVar4 == 0) {
        if (puVar16 == DAT_01042f9c) {
          uStack_4e = uStack_4e & 0xf81f | 0xe0;
          uStack_50 = CONCAT11(uStack_50._1_1_,bVar1) & 0xfe3f | 0xc0;
        }
        else {
          uStack_50 = CONCAT11(uStack_50._1_1_,bVar1) & 0xfe3f | 0x80;
        }
        uStack_4c = 4;
        apuStack_34[0] = puVar13 + 10;
        puStack_2c = puVar16;
      }
      else {
        if (puVar16 == DAT_01042f94) {
          uStack_50 = CONCAT11(uStack_50._1_1_,7);
          uStack_4e = (bVar1 & 0x3f) << 5 | uStack_4e & 0xf81f;
          uStack_50 = uStack_50 & 0xfe3f | 0xc0;
        }
        else {
          uStack_50 = CONCAT11(uStack_50._1_1_,bVar1) & 0xfe3f | 0x40;
        }
        uStack_4a = 4;
        apuStack_34[0] = puVar16;
        puStack_2c = puVar13 + 10;
      }
      uStack_20 = uVar14;
      iVar15 = (*(code *)(*(uint *)(*(int *)(*(int *)(iVar9 + 0x14) + 4) + 0x10) & 0xfffffffe))
                         (*(int *)(iVar9 + 0x14),*(undefined4 *)(iVar9 + 0x24),&uStack_50);
      uVar5 = *(undefined4 *)(iVar9 + 0x24);
      if (iVar15 == 0) {
        iVar15 = (*(code *)(*(uint *)(*(int *)(*(int *)(iVar9 + 0x14) + 4) + 0x14) & 0xfffffffe))();
        if (iVar15 == 0) {
          *puVar13 = *puVar13 | 0x40;
          puVar13[2] = puVar13[2] & 0xfffffdff | 0x40;
          puVar13[1] = puVar13[1] | 0x80;
          iVar15 = FUN_0108fde4(iVar9);
          if (iVar15 == 0) {
            uVar4 = *(uint *)(*(int *)(*(int *)(iVar9 + 0x14) + 4) + 0x2c);
            if (uVar4 == 0) {
              iVar15 = -0x23;
            }
            else {
              iVar15 = (*(code *)(uVar4 & 0xfffffffe))
                                 (*(int *)(iVar9 + 0x14),*(undefined4 *)(iVar9 + 0x24),5000);
              if (iVar15 == 0) {
                iVar15 = FUN_01042af0(puVar13);
              }
            }
          }
          puVar13[2] = puVar13[2] & 0xfffffdbf;
          iVar3 = *(int *)(iVar9 + 0x14);
          uVar5 = *(undefined4 *)(iVar9 + 0x24);
          uVar4 = *(uint *)(*(int *)(iVar3 + 4) + 0x18);
          *puVar13 = *puVar13 & 0xffffffbf;
          (*(code *)(uVar4 & 0xfffffffe))(iVar3,uVar5);
          goto LAB_01042c9a;
        }
        uVar5 = *(undefined4 *)(iVar9 + 0x24);
        uVar8 = 0x217;
        puVar12 = PTR_DAT_01042fa0;
      }
      else {
        uVar8 = 0x212;
        puVar12 = PTR_DAT_01042f98;
      }
      FUN_0106c4e8(1,0x5e,uVar8,puVar12,1,uVar5);
      iVar15 = -1;
    }
    else {
      puVar13[1] = puVar13[1] | 0x80;
      iVar9 = FUN_01090078();
      do {
        if ((int)uVar14 < 1) goto LAB_01042c04;
        iVar15 = FUN_01042a58(puVar2,puVar13,0x10);
        if (iVar15 != 0) {
          iVar15 = -5;
          goto LAB_01042c9a;
        }
        uVar10 = puVar13[2];
        uVar11 = uVar14;
        if ((puVar2[2] & 1) == 0) {
          if ((uVar10 & 0x1000) != 0) {
            uVar10 = (uint)*(byte *)(puVar2 + 5);
            if ((int)uVar10 <= (int)uVar14) {
              uVar11 = uVar10;
            }
            if (uVar4 == 0) goto LAB_01042d3a;
LAB_01042d74:
            if ((((uint)puVar16 & 3) == 0) && (uVar10 <= uVar11)) {
              apuStack_34[0] = (uint *)*puVar16;
            }
            else {
              func_0x000800aa(apuStack_34,puVar16,uVar11);
            }
            puVar13[10] = (uint)apuStack_34[0];
LAB_01042d92:
            puVar16 = (uint *)((int)puVar16 + uVar11);
            uVar14 = uVar14 - uVar11;
          }
        }
        else if (uVar4 == 0) {
          if ((uVar10 & 0x2000) == 0) {
            uVar10 = (uint)*(byte *)(puVar2 + 5);
            if ((int)uVar10 <= (int)uVar14) {
              uVar11 = uVar10;
            }
LAB_01042d3a:
            apuStack_34[0] = (uint *)puVar13[10];
            if ((((uint)puVar16 & 3) == 0) && (uVar10 <= uVar11)) {
              *puVar16 = (uint)apuStack_34[0];
            }
            else {
              func_0x000800aa(puVar16,apuStack_34,uVar11);
            }
            goto LAB_01042d92;
          }
        }
        else if ((uVar10 & 0x1000) == 0) {
          uVar10 = (uint)*(byte *)(puVar2 + 5);
          if ((int)uVar10 <= (int)uVar14) {
            uVar11 = uVar10;
          }
          goto LAB_01042d74;
        }
        iVar15 = FUN_01090054();
      } while ((uint)(iVar15 - iVar9) < uVar6 * 0x9c4);
      FUN_0106c4e8(1,0x5e,0x1be,PTR_DAT_01042d08,1,uVar4 != 0);
      iVar15 = -0x3c;
    }
  }
LAB_01042c9a:
  iVar9 = FUN_01042af0(puVar13,10000);
  iVar3 = FUN_01042a58(puVar2,puVar13,uVar7);
  if (iVar3 == 0 && (iVar15 == 0 && iVar9 == 0)) {
    uVar7 = 0;
    if ((*(int *)(param_2 + 0x24) == 0) && ((*(uint *)(param_2 + 4) & 1) != 0)) {
      if ((*(uint *)(param_2 + 4) & 2) == 0) {
        *(uint *)(param_2 + 0xc) = puVar13[6] << 0x18 | puVar13[5] >> 8;
        *(uint *)(param_2 + 0x10) = (puVar13[6] & 0xff) << 0x10;
      }
      else {
        *(uint *)(param_2 + 0x18) = puVar13[5];
        *(uint *)(param_2 + 0x14) = puVar13[6];
        *(uint *)(param_2 + 0x10) = puVar13[7];
        *(uint *)(param_2 + 0xc) = puVar13[8];
      }
    }
  }
  else {
    if (((puVar2[2] & 2) == 0) && (0 < *DAT_01042d0c)) {
      FUN_0104ba04(PTR_s___s__s__s___smmc_d__send_cmd_d_e_01042d18,PTR_DAT_01042d14,
                   PTR_s__ERR__01042d1c,PTR_s_mmc_acts_send_cmd_01042d20,
                   PTR_s__010f8ede_0x1b_01042d10,*(undefined1 *)((int)puVar2 + 0x13),*param_2,
                   puVar13[2],PTR_s__010f8ede_0x1b_01042d10);
    }
    uVar6 = *puVar13;
    uVar4 = puVar13[2];
    FUN_0106ce76(*(undefined1 *)((int)puVar2 + 0x11));
    *puVar13 = uVar6;
    puVar13[2] = uVar4;
    uVar7 = 0xfffffffb;
  }
  return uVar7;
}



/* FUN_01042af0 @ 01042af0 */

undefined4 FUN_01042af0(int param_1,uint param_2)

{
  int iVar1;
  int iVar2;
  
  iVar1 = FUN_01090078();
  do {
    if ((*(uint *)(param_1 + 4) & 0x80) == 0) {
      return 0;
    }
    iVar2 = FUN_01090054();
  } while ((uint)(iVar2 - iVar1) < param_2);
  FUN_0106c4e8(1,0x5e,0x17e,PTR_DAT_01042b34,1,param_2);
  return 0xffffffc4;
}



/* FUN_01012234 @ 01012234 */

void FUN_01012234(int param_1,char *param_2,int param_3,undefined4 param_4)

{
  char cVar1;
  char *pcVar2;
  undefined4 *puVar3;
  char *pcVar4;
  undefined4 *puVar5;
  int *piVar6;
  undefined4 *puVar7;
  int *piVar8;
  undefined4 uVar9;
  int iVar10;
  char *pcVar11;
  uint uVar12;
  int iVar13;
  
  puVar3 = DAT_010123dc;
  pcVar2 = DAT_010123d8;
  if (*DAT_010123d8 == '\x01') {
    *DAT_010123d8 = '\0';
    pcVar4 = DAT_010123e0;
    if (*DAT_010123e0 == -1) {
      *DAT_010123e0 = *param_2;
      uVar9 = FUN_01090054();
      puVar5 = DAT_010123e4;
      *puVar3 = uVar9;
      *puVar5 = uVar9;
    }
    piVar6 = DAT_010123e8;
    iVar10 = FUN_010121a4(param_2,param_3,DAT_010123e0);
    cVar1 = *param_2;
    if ((iVar10 == 0) && (cVar1 == *pcVar4)) {
      *piVar6 = *piVar6 + param_3;
      *DAT_010123ec = *DAT_010123ec + param_3;
      uVar9 = FUN_01090054();
      uVar12 = FUN_0105e1fc(uVar9,*puVar3);
      if (999 < uVar12) {
        uVar9 = FUN_01090054();
        iVar10 = *piVar6;
        *puVar3 = uVar9;
        piVar8 = DAT_01012410;
        FUN_0106c4e8(3,0x1de,0x20c,DAT_0101240c,1,iVar10);
        iVar10 = *piVar8;
        *piVar6 = 0;
        if ((iVar10 != 0) && (2 < *DAT_01012474)) {
          FUN_0104ba04(PTR_s___s__s__s___ssend__d_per_second__01012480,PTR_s_sppBLE_test_0101247c,
                       PTR_s__INF__01012484,PTR_s_rece_0_to_9_check_01012488,
                       PTR_s__010f8ede_0x1b_01012478,iVar10,PTR_s__010f8ede_0x1b_01012478);
        }
        *piVar8 = 0;
      }
    }
    else {
      if (cVar1 == *pcVar4) {
        FUN_0106c4e8(3,0x1de,0x1f1,DAT_01012400,1,iVar10);
        if (iVar10 < 2) {
          FUN_0104ba04(PTR_s__s_010e7b80_0x33_01012408,PTR_s_dataerr__010e0f4a_0xa_01012404);
          pcVar11 = param_2;
        }
        else {
          FUN_0104ba04(PTR_s__s_010e7b80_0x33_01012408,PTR_s_dataerr__010e0f4a_0xa_01012404);
          pcVar11 = param_2 + iVar10 + -2;
        }
        FUN_0108df4c(pcVar11,1,10,0x10,0);
      }
      else {
        FUN_0106c4e8(3,0x1de,0x1ef,DAT_010123f0,2,*pcVar4,cVar1);
      }
      puVar5 = DAT_010123e4;
      iVar10 = FUN_0105e1fc(*DAT_010123f4,*DAT_010123e4);
      if (iVar10 == 0) {
        iVar10 = 1;
      }
      iVar13 = *DAT_010123ec;
      uVar9 = func_0x0000050c(iVar13 * 1000,iVar10);
      FUN_0106c4e8(3,0x1de,0x1fd,DAT_010123f8,3,iVar13,iVar10,uVar9);
      FUN_0106c4e8(3,0x1de,0x200,DAT_010123fc,0);
      *piVar6 = 0;
      *DAT_010123ec = 0;
      *pcVar4 = -1;
      uVar9 = FUN_01090054();
      puVar7 = DAT_010123f4;
      *puVar5 = uVar9;
      *puVar7 = uVar9;
      *puVar3 = uVar9;
    }
    piVar6 = DAT_0101248c;
    if ((*(int *)(param_1 + 4) != 0) && ((param_3 - 100U & 0xffff) < 0x65)) {
      iVar10 = 0;
      do {
        (*(code *)(*(uint *)(param_1 + 4) & 0xfffffffe))(param_1,param_2,param_3,param_4);
        *piVar6 = *piVar6 + param_3;
        iVar10 = iVar10 + param_3;
      } while (param_3 + iVar10 < 0x29c);
    }
    uVar9 = FUN_01090054();
    *DAT_010123f4 = uVar9;
    *pcVar2 = '\x01';
  }
  return;
}



/* FUN_01041c30 @ 01041c30 */

undefined4 FUN_01041c30(undefined4 param_1)

{
  int iVar1;
  int iVar2;
  uint uStack_14;
  
  uStack_14 = 0;
  iVar1 = FUN_01090078();
  FUN_01041bb6(param_1,&uStack_14);
  while (((uStack_14 & 0x100) == 0 || ((uStack_14 >> 9 & 0xf) == 7))) {
    FUN_01041bb6(param_1,&uStack_14);
    iVar2 = FUN_01090054();
    if (499 < (uint)(iVar2 - iVar1)) {
      FUN_0106c4e8(1,0x5f,0x2ac,PTR_DAT_01041c9c,1,uStack_14);
      return 0xffffffc4;
    }
    FUN_0108fad8(10);
  }
  return 0;
}



/* FUN_0104b202 @ 0104b202 */

int FUN_0104b202(undefined4 param_1,int param_2)

{
  int iVar1;
  int iVar2;
  int iVar3;
  
  iVar1 = FUN_01090054();
  while ((iVar2 = FUN_0103dd30(param_1), iVar2 != 0 && (param_2 != 0))) {
    iVar3 = FUN_01090054();
    if (9999 < (uint)(iVar3 - iVar1)) {
      return iVar2;
    }
    FUN_0108fad8(100);
  }
  return iVar2;
}



/* FUN_0104b1c4 @ 0104b1c4 */

int FUN_0104b1c4(undefined4 param_1,int param_2)

{
  int iVar1;
  int iVar2;
  int iVar3;
  
  iVar1 = FUN_01090054();
  while ((iVar2 = FUN_0103dd30(param_1), iVar2 != 0 && (param_2 != 0))) {
    iVar3 = FUN_01090054();
    if (9999 < (uint)(iVar3 - iVar1)) {
      return iVar2;
    }
    FUN_0108fad8(100);
  }
  return iVar2;
}



/* FUN_01069db0 @ 01069db0 */

int FUN_01069db0(int param_1,int param_2)

{
  bool bVar1;
  char *pcVar2;
  undefined4 uVar3;
  int iVar4;
  int iVar5;
  undefined1 uVar6;
  undefined1 uVar7;
  char *pcVar8;
  int iStack_30;
  undefined4 uStack_18;
  
  pcVar2 = DAT_01069f14;
  iVar5 = DAT_01069f10;
  bVar1 = false;
  pcVar8 = *(char **)(DAT_01069f10 + 0x5c);
  do {
    if (*pcVar2 == '\0') {
      return 4;
    }
    uVar3 = FUN_0106978c(iVar5,0x1f,1,5000);
    iVar4 = FUN_01069bfc(uVar3,*(undefined4 *)(iVar5 + 0x68));
    if (iVar4 != 0) {
      FUN_0104ba04(PTR_s_usb_send_cbw_failed__01069f18);
      goto LAB_01069dfe;
    }
    if (param_1 == 0) {
LAB_01069e42:
      iStack_30 = 0;
    }
    else if (param_2 == 0) {
      uVar3 = FUN_0106978c(pcVar8,param_1,1,5000);
      iVar4 = FUN_01069bfc(uVar3,*(undefined4 *)(iVar5 + 0x68));
      if (iVar4 != 2) {
        if (iVar4 != 0) goto LAB_01069dfe;
        goto LAB_01069e42;
      }
      iStack_30 = 1;
    }
    else {
      uVar3 = FUN_0106978c(pcVar8,param_1,0,5000);
      iVar4 = FUN_01069bfc(uVar3,*(undefined4 *)(iVar5 + 0x6c));
      iStack_30 = param_2;
      if (iVar4 != 2) {
        if (iVar4 != 0) goto LAB_01069dfe;
        iStack_30 = 0;
      }
      if (*(char *)(iVar5 + 0xf) == '\x12') {
        if (*pcVar8 != '\0') {
          FUN_0106c4e8(3,0x275,0x1b3,DAT_01069f20,0);
        }
      }
      else if (*(char *)(iVar5 + 0xf) == '%') {
        uVar6 = (undefined1)*(undefined4 *)pcVar8;
        uVar7 = (undefined1)((uint)*(undefined4 *)pcVar8 >> 8);
        *(uint *)(iVar5 + 0x60) = CONCAT31(CONCAT21(CONCAT11(uVar6,uVar7),uVar7),uVar6);
        uVar6 = (undefined1)*(undefined4 *)(pcVar8 + 4);
        uVar7 = (undefined1)((uint)*(undefined4 *)(pcVar8 + 4) >> 8);
        *(uint *)(iVar5 + 100) = CONCAT31(CONCAT21(CONCAT11(uVar6,uVar7),uVar7),uVar6);
      }
    }
    iVar4 = FUN_01069c30(DAT_01069f24);
    if (iVar4 == 2) {
      iStack_30 = 1;
    }
    else if (iVar4 == 4) goto LAB_01069dfe;
    if ((*(char *)(iVar5 + 0xf) == '\0') && (*(char *)(iVar5 + 0x58) != '\0')) {
      return 5;
    }
    if (iStack_30 == 0) {
      return 0;
    }
    FUN_01069c90();
    if (bVar1) {
      iVar4 = 2;
LAB_01069dfe:
      if (*pcVar2 != '\x02') {
        return 4;
      }
      uStack_18 = FUN_01090054();
      iVar5 = FUN_01069a7c();
      if ((iVar5 != 0) || (iVar5 = FUN_01069c90(), iVar5 != 0)) {
        *pcVar2 = '\0';
        FUN_01069d8c();
      }
      uVar3 = FUN_010900b6(&uStack_18);
      FUN_0106c4e8(3,0x275,0xdc,DAT_01069f1c,1,uVar3);
      return iVar4;
    }
    bVar1 = true;
  } while( true );
}



/* FUN_0104121c @ 0104121c */

undefined4 FUN_0104121c(undefined4 param_1,undefined4 param_2,undefined4 param_3,undefined4 param_4)

{
  undefined4 *puVar1;
  undefined4 *puVar2;
  int iVar3;
  int iVar4;
  undefined4 uVar5;
  undefined4 local_18;
  
  puVar1 = DAT_0104129c;
  *DAT_0104129c = 0;
  iVar4 = DAT_010412a0;
  *(undefined1 *)(DAT_010412a0 + 8) = 1;
  *(char *)(iVar4 + 0x272) = (char)param_3;
  *(char *)(iVar4 + 0x273) = (char)((uint)param_3 >> 8);
  iVar4 = DAT_010412a8;
  puVar2 = DAT_010412a4;
  if ((bRam0000000b & 2) == 0) {
    bRam0000000b = bRam0000000b | 2;
  }
  *(short *)(DAT_010412a4 + 2) = (short)param_3;
  puVar2[1] = param_2;
  *puVar2 = param_1;
  iVar3 = DAT_010412ac;
  *(undefined4 *)(iVar4 + 8) = 0;
  *(byte *)(iVar3 + 0x11) = *(byte *)(iVar3 + 0x11) | 2;
  local_18 = FUN_01090054();
  iVar4 = FUN_0108fde4(iVar4,param_4);
  if (iVar4 != 0) {
    uVar5 = FUN_010900b6(&local_18);
    FUN_0104ba04(PTR_s_aotg_read_timeout__d_ms___ret____010412b0,param_4,iVar4,uVar5);
    *puVar1 = 0xffffffca;
  }
  return *puVar1;
}



/* FUN_01084f5c @ 01084f5c */

void FUN_01084f5c(undefined4 param_1)

{
  uint uVar1;
  uint uVar2;
  int iVar3;
  
  uVar1 = FUN_01090054();
  iVar3 = *DAT_01084fb4;
  if ((((iVar3 != 0) && (uVar2 = *(uint *)(iVar3 + 0x40), uVar2 != 0)) && (uVar2 < uVar1)) &&
     (300 < uVar1 - uVar2)) {
    FUN_0106c4e8(3,0x164,0xcf6,PTR_DAT_01084fb8,2,uVar1,uVar2);
    FUN_0107c100(0,0x46,0);
    *(undefined4 *)(iVar3 + 0x40) = 0;
    FUN_01072c10(param_1);
  }
  return;
}



/* FUN_01081c34 @ 01081c34 */

undefined4 FUN_01081c34(uint param_1,uint param_2)

{
  bool bVar1;
  char cVar2;
  int *piVar3;
  undefined4 uVar4;
  int iVar5;
  uint uVar6;
  uint uVar7;
  uint uVar8;
  undefined *puVar9;
  uint uVar10;
  char *pcVar11;
  undefined *puVar12;
  uint uStack_6c;
  uint *puStack_68;
  ushort uStack_52;
  int iStack_50;
  uint uStack_4c;
  int local_48;
  uint uStack_44;
  int iStack_40;
  uint uStack_3c;
  uint uStack_38;
  uint uStack_34;
  int iStack_30;
  uint uStack_2c;
  uint uStack_28;
  uint uStack_24;
  uint uStack_20;
  undefined1 auStack_1c [8];
  
  piVar3 = DAT_01081dc4;
  uStack_24 = 0;
  uStack_20 = 0;
  iStack_50 = 0;
  uStack_4c = 0;
  local_48 = -1;
  pcVar11 = (char *)*DAT_01081dc4;
  uStack_44 = 0;
  iStack_40 = 0;
  uStack_52 = 0;
  if (param_1 == 0) {
    pcVar11[0x44] = '\0';
    pcVar11[0x45] = '\0';
    pcVar11[0x46] = '\0';
    pcVar11[0x47] = '\0';
  }
  else if (*(int *)(pcVar11 + 0x44) == 0) {
    uVar4 = FUN_01090054();
    *(undefined4 *)(pcVar11 + 0x44) = uVar4;
  }
  else {
    iVar5 = FUN_01090054();
    if ((uint)(iVar5 - *(int *)(pcVar11 + 0x44)) < param_1) {
      return 0;
    }
  }
  if (pcVar11 == (char *)0x0) {
    return 0;
  }
  if (*pcVar11 != '\x03') {
    return 0;
  }
  if (*(int *)(pcVar11 + 0x218) == 0) {
    return 0;
  }
  func_0x000808e4();
  func_0x000805dc(auStack_1c);
  uStack_3c = FUN_01080fe0();
  uStack_38 = param_2;
  if (((*(int *)(pcVar11 + 100) != 0) && (*(int *)(pcVar11 + 0x6c) != 0)) &&
     (*(int *)(pcVar11 + 0x70) != 0)) {
    if (*(char *)(*piVar3 + 0x233) == '\0') {
      do {
        if (uStack_4c - local_48 == 2) goto LAB_01081d48;
        iVar5 = FUN_01081bb4(&iStack_50,&uStack_4c,&local_48,&uStack_52);
      } while (iVar5 != 0);
      func_0x0008060c(auStack_1c);
      FUN_0108f974();
      if (*DAT_01081dc8 < 4) {
        return 0;
      }
      uVar4 = 0x98;
    }
    else {
      do {
        if ((uStack_4c - local_48 == 4) || (pcVar11[0x233] == '\0')) goto LAB_01081d48;
        iVar5 = FUN_01081bb4(&iStack_50,&uStack_4c,&local_48,&uStack_52);
      } while (iVar5 != 0);
      func_0x0008060c(auStack_1c);
      FUN_0108f974();
      if (*DAT_01081dc8 < 4) {
        return 0;
      }
      uVar4 = 0xa6;
    }
    FUN_0104ba04(PTR_s___s__s__s___sfail__d_s_01081ddc,PTR_s_general_01081dd8,PTR_s__DBG__01081dd0,
                 PTR_s_calc_audio_data_sample_cnt_ext_01081dd4,PTR_s__010f8ede_0x1b_01081dcc,uVar4,
                 PTR_s__010f8ede_0x1b_01081dcc);
    return 0;
  }
  iVar5 = 0;
  uStack_6c = 0;
  puStack_68 = (uint *)0x0;
LAB_01081d5e:
  func_0x0008060c(auStack_1c);
  uVar8 = uStack_38;
  uVar10 = uStack_3c;
  if ((uStack_38 & 0x80000000) == 0) {
    if (iVar5 == 0) {
      uStack_44 = uStack_44 & 0xfffffffc;
      *(uint *)(pcVar11 + 0x54) = uStack_44 * 0x138 + (uStack_44 >> 1) + iStack_40;
      if (pcVar11[0x3d] != '\0') {
        uVar7 = (uint)CARRY4((uint)uStack_52,(uint)*(ushort *)(pcVar11 + 0x5c) * 0x10000);
        iVar5 = (uint)uStack_52 + (uint)*(ushort *)(pcVar11 + 0x5c) * 0x10000 + 1;
        if (iVar5 == 0) {
          uVar7 = uVar7 + 1;
        }
        uVar6 = func_0x00000588(iVar5,uVar7,iStack_50,0);
        uStack_2c = (uVar6 - uStack_4c) - uStack_6c;
        uStack_28 = ((uVar7 - (uStack_4c <= uVar6 ^ 1)) - (int)puStack_68) -
                    (uStack_6c <= uVar6 - uStack_4c ^ 1);
        if ((uStack_28 & 0x80000000) != 0) {
          uStack_2c = 0;
          uStack_28 = 0;
        }
        iStack_30 = (int)uVar8 >> 2;
        uVar7 = uVar10 >> 2 | uVar8 << 0x1e;
        uVar8 = uStack_2c >> 2 | uStack_28 << 0x1e;
        uVar10 = uVar7 - uVar8;
        uStack_20 = (iStack_30 - ((int)uStack_28 >> 2)) - (uVar8 <= uVar7 ^ 1);
        uStack_34 = uVar7;
        uStack_24 = uVar10;
        if (3 < *DAT_01082004) {
          uVar4 = func_0x00080082();
          puVar9 = PTR_s__010f8ede_0x1b_01082008;
          puVar12 = PTR_s__010f8ede_0x1b_01082008;
          uVar4 = func_0x0000050c(uVar4,0x18);
          FUN_0104ba04(PTR_s___s__s__s___s_u__u__u__u__s_01082018,PTR_s_general_01082014,
                       PTR_s__DBG__0108200c,PTR_s_calc_audio_data_sample_cnt_ext_01082010,puVar9,
                       uVar10,uVar7,uVar8,uVar4,puVar12);
        }
        if ((int)uStack_20 < 1) {
          if (uStack_20 != 0) {
            if ((uStack_20 & 0x80000000) != 0) {
              FUN_0108df4c(&uStack_3c,1,8,0x10,0xffffffff);
              FUN_0108df4c(&uStack_34,1,8,0x10,0xffffffff);
              FUN_0108df4c(&uStack_2c,1,8,0x10,0xffffffff);
              FUN_0106c4e8(3,0x164,0x105,PTR_DAT_01082158,2,uStack_24,uStack_34);
              uVar8 = (uint)(byte)pcVar11[0x3d];
              uVar7 = (uint)uStack_52;
              iVar5 = iStack_50;
              uVar10 = uStack_4c;
              FUN_0106c4e8(3,0x164,0x106,PTR_DAT_0108214c,4,uVar7,iStack_50,uStack_4c,uVar8);
              cVar2 = pcVar11[0x22f];
              pcVar11[0x22f] = cVar2 + '\x01';
              if ((char)(cVar2 + '\x01') == -0x38) {
                FUN_0106c4e8(2,0x164,0x10c,PTR_DAT_0108215c,0,uVar7,iVar5,uVar10,uVar8);
                pcVar11[0x22f] = '\0';
                FUN_0107c100(0,0x46,0);
              }
            }
            goto LAB_01081fbc;
          }
          if (uStack_24 < 0x10001) goto LAB_01081fbc;
        }
        FUN_0106c4e8(3,0x164,0xe5,PTR_DAT_0108201c,0);
        FUN_0108df4c(&uStack_24,1,8,0x10,0xffffffff);
        bVar1 = CARRY4(uStack_2c,iStack_50 * 0x10000);
        uStack_2c = uStack_2c + iStack_50 * 0x10000;
        uStack_28 = uStack_28 + bVar1;
        uVar10 = uStack_2c >> 2 | uStack_28 * 0x40000000;
        uStack_24 = uStack_34 - uVar10;
        uStack_20 = (iStack_30 - ((int)uStack_28 >> 2)) - (uVar10 <= uStack_34 ^ 1);
        if ((uStack_20 != 0) || (0x10000 < uStack_24)) {
          FUN_0106c4e8(1,0x164,0xed,PTR_DAT_01082020,0);
          FUN_0106c4e8(3,0x164,0xee,PTR_DAT_01082024,2,uStack_24,uStack_3c);
          uVar8 = (uint)uStack_52;
          iVar5 = iStack_50;
          uVar10 = uStack_4c;
          FUN_0106c4e8(3,0x164,0xef,PTR_DAT_01082028,3,uVar8,iStack_50,uStack_4c);
          FUN_0108f974();
          cVar2 = pcVar11[0x22f];
          pcVar11[0x22f] = cVar2 + '\x01';
          if ((char)(cVar2 + '\x01') != -0x38) {
            return 0;
          }
          FUN_0106c4e8(2,0x164,0xf4,PTR_DAT_0108202c,0,uVar8,iVar5,uVar10);
          pcVar11[0x22f] = '\0';
          FUN_0107c100(0,0x46,0);
          return 0;
        }
        *(short *)(pcVar11 + 0x5c) = *(short *)(pcVar11 + 0x5c) + 1;
        uStack_20 = 0;
LAB_01081fbc:
        piVar3 = DAT_01082030;
        *(uint *)(pcVar11 + 0x58) = uStack_24;
        iVar5 = FUN_01090054();
        if (3000 < (uint)(iVar5 - *piVar3)) {
          FUN_0108df4c(&uStack_3c,1,8,0x10,0xffffffff);
          FUN_0106c4e8(4,0x164,0x11b,PTR_DAT_01082024,2,uStack_24,uStack_3c);
          FUN_0106c4e8(4,0x164,0x11d,PTR_DAT_0108214c,3,uStack_52,iStack_50,uStack_4c);
          FUN_0106c4e8(4,0x164,0x11e,PTR_DAT_01082150,1,*(undefined4 *)(pcVar11 + 0x54));
          FUN_0106c4e8(4,0x164,0x11f,PTR_DAT_01082154,1,uStack_6c);
          iVar5 = FUN_01090054();
          *piVar3 = iVar5;
        }
        uVar4 = FUN_01090054();
        *(undefined4 *)(pcVar11 + 0x44) = uVar4;
        FUN_0108f974();
        return 1;
      }
      uVar4 = 0xcf;
      puVar9 = PTR_DAT_01081de0;
    }
    else {
      uVar4 = 0xc6;
      puVar9 = PTR_DAT_01081de4;
    }
    FUN_0106c4e8(3,0x164,uVar4,puVar9,0);
  }
  FUN_0108f974();
  return 0;
LAB_01081d48:
  puStack_68 = &uStack_44;
  iVar5 = func_0x000807be(1,puStack_68,&iStack_40);
  uStack_6c = (*(code *)(*(uint *)(pcVar11 + 0x70) & 0xfffffffe))(*(undefined4 *)(pcVar11 + 100));
  goto LAB_01081d5e;
}



/* FUN_01085b08 @ 01085b08 */

undefined4 FUN_01085b08(undefined4 param_1,int *param_2)

{
  bool bVar1;
  int *piVar2;
  int iVar3;
  undefined4 uVar4;
  uint uVar5;
  uint uVar6;
  uint uVar7;
  char cVar8;
  int iVar9;
  uint uStack_5c;
  int *piStack_58;
  ushort uStack_4a;
  int iStack_48;
  uint uStack_44;
  uint local_40;
  uint uStack_3c;
  int *piStack_38;
  uint uStack_34;
  int iStack_30;
  uint uStack_2c;
  uint uStack_28;
  uint uStack_24;
  uint uStack_20;
  undefined1 auStack_1c [8];
  
  iVar9 = *DAT_01085c34;
  uStack_24 = 0;
  uStack_20 = 0;
  iStack_48 = 0;
  uStack_44 = 0;
  local_40 = 0xffffffff;
  uStack_4a = 0;
  if (iVar9 == 0) {
    return 0;
  }
  if ((*(byte *)(iVar9 + 1) & 0xc0) != 0x40) {
    return 0;
  }
  if (*(int *)(iVar9 + 0xdc) == 0) {
    return 0;
  }
  if (*(byte *)(iVar9 + 0x1c1) < 2) {
    return 0;
  }
  func_0x000808e4();
  func_0x000805dc(auStack_1c);
  uStack_3c = FUN_01080fe0();
  piStack_38 = param_2;
  if (((*(int *)(iVar9 + 0x80) == 0) || (*(uint *)(iVar9 + 0x140) == 0)) ||
     (*(int *)(iVar9 + 0x144) == 0)) {
    uStack_5c = 0;
    piStack_58 = (int *)0x0;
  }
  else {
    if (*(char *)(iVar9 + 0x1c3) == '\0') {
      param_2 = &iStack_48;
      iVar3 = (*(code *)(*(uint *)(iVar9 + 0x140) & 0xfffffffe))
                        (*(int *)(iVar9 + 0x80),param_2,&uStack_44,&uStack_4a);
      if (iVar3 != 0) {
LAB_01085bd6:
        func_0x0008060c(auStack_1c);
        goto LAB_01085bdc;
      }
    }
    else {
      while ((uStack_44 - local_40 != 4 && (*(char *)(iVar9 + 0x1c3) != '\0'))) {
        iVar3 = (*(code *)(*(uint *)(iVar9 + 0x140) & 0xfffffffe))
                          (*(undefined4 *)(iVar9 + 0x80),&iStack_48,&uStack_44,&uStack_4a);
        if (iVar3 != 0) goto LAB_01085bd6;
        do {
          param_2 = &iStack_48;
          iVar3 = (*(code *)(*(uint *)(iVar9 + 0x140) & 0xfffffffe))
                            (*(undefined4 *)(iVar9 + 0x80),param_2,&local_40,&uStack_4a);
          if (iVar3 != 0) goto LAB_01085bd6;
        } while (local_40 == uStack_44);
      }
    }
    uVar4 = func_0x00080408();
    *(undefined4 *)(iVar9 + 0x18c) = uVar4;
    uStack_5c = (*(code *)(*(uint *)(iVar9 + 0x144) & 0xfffffffe))(*(undefined4 *)(iVar9 + 0x80));
    piStack_58 = param_2;
  }
  func_0x0008060c(auStack_1c);
  piVar2 = piStack_38;
  uVar5 = uStack_3c;
  if (((uint)piStack_38 & 0x80000000) == 0) {
    if (*(char *)(iVar9 + 0x15f) != '\0') {
      uVar7 = (uint)*(ushort *)(iVar9 + 0x162) * 0x10000;
      uVar6 = (uint)CARRY4((uint)uStack_4a,uVar7);
      iVar3 = uStack_4a + uVar7 + 1;
      if (iVar3 == 0) {
        uVar6 = uVar6 + 1;
      }
      uVar7 = func_0x00000588(iVar3,uVar6,iStack_48,0);
      uStack_2c = (uVar7 - uStack_44) - uStack_5c;
      uStack_28 = ((uVar6 - (uStack_44 <= uVar7 ^ 1)) - (int)piStack_58) -
                  (uStack_5c <= uVar7 - uStack_44 ^ 1);
      if ((uStack_28 & 0x80000000) != 0) {
        uStack_2c = 0;
        uStack_28 = 0;
      }
      uStack_34 = uVar5 >> 2 | (int)piVar2 << 0x1e;
      iStack_30 = (int)piVar2 >> 2;
      uVar5 = uStack_2c >> 2 | uStack_28 << 0x1e;
      uStack_24 = uStack_34 - uVar5;
      uStack_20 = (iStack_30 - ((int)uStack_28 >> 2)) - (uVar5 <= uStack_34 ^ 1);
      if (((int)uStack_20 < 1) && ((uStack_20 != 0 || (uStack_24 < 0x10001)))) {
        if ((uStack_20 & 0x80000000) != 0) {
          FUN_0108df4c(&uStack_3c,1,8,0x10,0xffffffff);
          FUN_0108df4c(&uStack_34,1,8,0x10,0xffffffff);
          FUN_0108df4c(&uStack_2c,1,8,0x10,0xffffffff);
          FUN_0106c4e8(3,0x174,0x98,PTR_DAT_01085f40,3,uStack_24,uStack_34,uStack_2c);
          uVar6 = (uint)*(byte *)(iVar9 + 0x15f);
          uVar7 = (uint)uStack_4a;
          iVar3 = iStack_48;
          uVar5 = uStack_44;
          FUN_0106c4e8(3,0x174,0x99,PTR_DAT_01085f44,4,uVar7,iStack_48,uStack_44,uVar6);
          cVar8 = *(char *)(iVar9 + 0x164) + '\x01';
          *(char *)(iVar9 + 0x164) = cVar8;
          if (cVar8 == -0x38) {
            FUN_0106c4e8(2,0x174,0x9f,PTR_DAT_01085f48,0,uVar7,iVar3,uVar5,uVar6);
            *(undefined1 *)(iVar9 + 0x164) = 0;
            FUN_0107c100(0,0x46,0);
          }
        }
      }
      else {
        FUN_0106c4e8(3,0x174,0x75,PTR_DAT_01085e70,0);
        FUN_0108df4c(&uStack_24,1,8,0x10,0xffffffff);
        bVar1 = CARRY4(uStack_2c,iStack_48 * 0x10000);
        uStack_2c = uStack_2c + iStack_48 * 0x10000;
        uStack_28 = uStack_28 + bVar1;
        uVar5 = uStack_2c >> 2 | uStack_28 * 0x40000000;
        uStack_24 = uStack_34 - uVar5;
        uStack_20 = (iStack_30 - ((int)uStack_28 >> 2)) - (uVar5 <= uStack_34 ^ 1);
        if ((uStack_20 != 0) || (0x10000 < uStack_24)) {
          FUN_0106c4e8(1,0x174,0x7e,PTR_DAT_01085e74,0);
          FUN_0106c4e8(3,0x174,0x7f,PTR_DAT_01085e78,2,uStack_24,uStack_3c);
          uVar6 = (uint)uStack_4a;
          iVar3 = iStack_48;
          uVar5 = uStack_44;
          FUN_0106c4e8(3,0x174,0x80,PTR_DAT_01085e7c,3,uVar6,iStack_48,uStack_44);
          FUN_0108f974();
          cVar8 = *(char *)(iVar9 + 0x164) + '\x01';
          *(char *)(iVar9 + 0x164) = cVar8;
          if (cVar8 != -0x38) {
            return 0;
          }
          FUN_0106c4e8(2,0x174,0x86,PTR_DAT_01085e80,0,uVar6,iVar3,uVar5);
          *(undefined1 *)(iVar9 + 0x164) = 0;
          FUN_0107c100(0,0x46,0);
          return 0;
        }
        *(short *)(iVar9 + 0x162) = *(short *)(iVar9 + 0x162) + 1;
        uStack_20 = 0;
      }
      piVar2 = DAT_01085e84;
      *(uint *)(iVar9 + 400) = uStack_24;
      iVar3 = FUN_01090054();
      if (3000 < (uint)(iVar3 - *piVar2)) {
        FUN_0108df4c(&uStack_3c,1,8,0x10,0xffffffff);
        FUN_0106c4e8(3,0x174,0xad,PTR_DAT_01085e78,2,uStack_24,uStack_3c);
        FUN_0106c4e8(3,0x174,0xaf,PTR_DAT_01085e7c,3,uStack_4a,iStack_48,uStack_44);
        FUN_0106c4e8(3,0x174,0xb0,PTR_DAT_01085e88,1,*(undefined4 *)(iVar9 + 0x18c));
        FUN_0106c4e8(3,0x174,0xb1,PTR_DAT_01085e8c,1,uStack_5c);
        iVar9 = FUN_01090054();
        *piVar2 = iVar9;
      }
      FUN_0108f974();
      return 1;
    }
    FUN_0106c4e8(3,0x174,0x61,PTR_DAT_01085c38,0);
  }
LAB_01085bdc:
  FUN_0108f974();
  return 0;
}



/* FUN_01086df8 @ 01086df8 */

void FUN_01086df8(void)

{
  uint uVar1;
  uint uVar2;
  int iVar3;
  
  uVar1 = FUN_01090054();
  iVar3 = *DAT_01086e50;
  if ((((iVar3 != 0) && (uVar2 = *(uint *)(iVar3 + 0x1c4), uVar2 != 0)) && (uVar2 < uVar1)) &&
     (500 < uVar1 - uVar2)) {
    if (2 < *DAT_01086e54) {
      FUN_0104ba04(PTR_s___s__s__s___scur__d_prev__d_s_01086e68,PTR_s_general_01086e5c,
                   PTR_s__INF__01086e64,PTR_s_bt_eg_check_tws_active_01086e60,
                   PTR_s__010f8ede_0x1b_01086e58,uVar1,uVar2,PTR_s__010f8ede_0x1b_01086e58);
    }
    FUN_0107c100(0,0x4e,0);
    *(undefined4 *)(iVar3 + 0x1c4) = 0;
  }
  return;
}



/* FUN_01005548 @ 01005548 */

uint FUN_01005548(int param_1,uint param_2)

{
  byte bVar1;
  int *piVar2;
  byte *pbVar3;
  int iVar4;
  uint uVar5;
  undefined4 uVar6;
  int iVar7;
  
  iVar4 = FUN_01090054();
  piVar2 = DAT_01005684;
  iVar7 = *DAT_01005684;
  *DAT_01005684 = iVar4;
  pbVar3 = DAT_01005688;
  if ((uint)(iVar4 - iVar7) < 0x1f5) {
    bVar1 = *DAT_01005688;
    *DAT_01005688 = bVar1 + 1;
    if (0xf < (byte)(bVar1 + 1)) {
      *pbVar3 = 0;
      FUN_0106c4e8(2,0x220,0xbc,DAT_01005694,2,*piVar2,0);
      return 0xffffffff;
    }
  }
  else {
    *DAT_01005688 = 0;
  }
  iVar4 = FUN_0104c120();
  if (iVar4 == 0) {
    uVar6 = FUN_0104bed8();
    FUN_0106c4e8(2,0x220,0xd0,DAT_01005698,1,uVar6);
    return 0xffffffff;
  }
  FUN_0106c4e8(3,0x220,0xd4,PTR_DAT_0100568c,1,0);
  uVar5 = FUN_010513fc(param_1);
  iVar4 = FUN_0100e050();
  if (iVar4 == 4) {
    return uVar5;
  }
  if (param_2 < 2) {
    if (param_2 == 0) {
      uVar5 = uVar5 - 1;
      if ((uVar5 & 0x80000000) != 0) {
        uVar5 = 0;
      }
      goto LAB_010055b4;
    }
    uVar5 = uVar5 + 1;
  }
  else {
    uVar5 = param_2 - 2;
  }
  if (0x10 < (int)uVar5) {
    uVar5 = 0x10;
  }
LAB_010055b4:
  iVar4 = FUN_010053ac(param_1,uVar5);
  if ((param_1 != 5) && (iVar7 = FUN_0100e050(), iVar7 == 3)) {
    FUN_0100fcc0(uVar5);
  }
  FUN_01005374(param_1);
  FUN_0100531c(1,param_1,uVar5);
  if (iVar4 == 2) {
    uVar6 = 0x18;
  }
  else if (iVar4 == 1) {
    uVar6 = 0x17;
  }
  else if (param_2 == 0) {
    uVar6 = 0x44;
  }
  else {
    uVar6 = 0x43;
  }
  FUN_01017a08(uVar6);
  FUN_0106c4e8(3,0x220,0x11c,DAT_01005690,1,uVar5);
  return uVar5;
}



/* FUN_01009574 @ 01009574 */

void FUN_01009574(int param_1)

{
  int iVar1;
  undefined4 uVar2;
  uint uVar3;
  int iVar4;
  uint uVar5;
  
  if ((param_1 != 0) && (iVar1 = FUN_0100653c(PTR_FUN_01009668,param_1,0), iVar1 == 0)) {
    *(byte *)(param_1 + 8) = *(byte *)(param_1 + 8) & 0x7f;
    iVar1 = FUN_0109094c(param_1 + 0x178);
    if (iVar1 != 0) {
      FUN_0109091c(param_1 + 0x178);
    }
    if ((*(byte *)(param_1 + 8) & 0x20) == 0) {
      uVar5 = (uint)*(byte *)(param_1 + 6);
      FUN_0106c4e8(3,0x1da,0x49,DAT_0100966c,1,uVar5);
      uVar2 = FUN_01090054();
      uVar3 = FUN_0105e1fc(uVar2,*(undefined4 *)(param_1 + 0x248));
      if (uVar3 < 2000) {
        iVar1 = param_1 + 0x1d8;
        iVar4 = FUN_0109094c(iVar1);
        if (iVar4 != 0) {
          return;
        }
        iVar4 = 2000 - uVar3;
        FUN_0106c4e8(3,0x1da,0x53,DAT_01009670,1,iVar4);
        FUN_01090810(iVar1,PTR_LAB_01009674,param_1);
        uVar2 = 0;
      }
      else {
        iVar1 = param_1 + 0x1f8;
        iVar4 = FUN_0109094c(iVar1);
        if (iVar4 != 0) {
          FUN_0106c4e8(3,0x1da,0x5b,DAT_01009678,0,uVar5);
          return;
        }
        uVar2 = FUN_01090054();
        *(undefined4 *)(param_1 + 0x24c) = uVar2;
        *(byte *)(param_1 + 10) = *(byte *)(param_1 + 10) | 0x20;
        FUN_01006480(param_1,0x10,0);
        FUN_01090810(iVar1,PTR_LAB_0100967c,param_1);
        uVar2 = 100;
        iVar4 = 100;
      }
      FUN_01090848(iVar1,iVar4,uVar2);
    }
  }
  return;
}



/* FUN_0105e878 @ 0105e878 */

int FUN_0105e878(int param_1,int param_2,int param_3)

{
  bool bVar1;
  int *piVar2;
  undefined *puVar3;
  int iVar4;
  int iVar5;
  undefined4 uVar6;
  int iVar7;
  uint uVar8;
  undefined4 uVar9;
  undefined4 uVar10;
  int iVar11;
  uint uVar12;
  int iVar13;
  undefined *puVar14;
  int iStack_30;
  int iStack_2c;
  
  iVar7 = param_1 + 0x14c;
  iVar4 = FUN_01061b38(iVar7,*(undefined1 *)(param_3 + 0xe));
  puVar3 = PTR_s__010f8ede_0x1b_0105e9f8;
  piVar2 = DAT_0105e9f4;
  uVar12 = iVar4 - 1;
  if (*DAT_0105e9f4 < 3) {
    if (uVar12 < 6) {
      iVar4 = func_0x00000b68(uVar12);
      return iVar4;
    }
LAB_0105eb6c:
    bVar1 = true;
  }
  else {
    puVar14 = PTR_s__010f8ede_0x1b_0105e9f8;
    FUN_0104ba04(PTR_s___s__s__s___sfile__s__file_id__d_0105ea04,PTR_s_general_0105ea00,
                 PTR_s__INF__0105e9fc,PTR_s_ota_write_and_verify_file_0105ea08,
                 PTR_s__010f8ede_0x1b_0105e9f8,param_3,*(undefined1 *)(param_3 + 0xe),iVar4,
                 PTR_s__010f8ede_0x1b_0105e9f8);
    if (5 < uVar12) {
      if (2 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___sfile__s__file_id__d_0105ec48,PTR_s_general_0105ec28,
                     PTR_s__INF__0105ec20,PTR_s_ota_write_and_verify_file_0105ec44,puVar3,param_3,
                     *(undefined1 *)(param_3 + 0xe),puVar3,puVar14);
      }
      goto LAB_0105eb6c;
    }
    func_0x00000b4c(uVar12);
    if (2 < *piVar2) {
      FUN_0104ba04(PTR_s___s__s__s___sfile__s__file_id__d_0105ea0c,PTR_s_general_0105ea00,
                   PTR_s__INF__0105e9fc,PTR_s_ota_write_and_verify_file_0105ea08,
                   PTR_s__010f8ede_0x1b_0105e9f8,param_3,*(undefined1 *)(param_3 + 0xe),
                   PTR_s__010f8ede_0x1b_0105e9f8,puVar14);
    }
    bVar1 = false;
  }
  iVar11 = 0;
  uVar12 = FUN_01061500(*(undefined4 *)(param_1 + 0x14));
  uVar8 = (uint)(*(byte *)(param_2 + 10) >> 4);
  if ((uVar12 != uVar8) && (1 < *piVar2)) {
    FUN_0104ba04(PTR_s___s__s__s___sWarnning___storage_e_0105ea18,PTR_s_general_0105ea00,
                 PTR_s__WRN__0105ea1c,PTR_s_ota_write_and_verify_file_0105ea08,
                 PTR_s__010f8ede_0x1b_0105e9f8,*(undefined1 *)(param_2 + 9),uVar8,uVar12,
                 PTR_s__010f8ede_0x1b_0105e9f8);
  }
  if (((*(uint *)(param_1 + 8) & 1) != 0) && (bVar1)) {
    if (((*(uint *)(param_1 + 8) & 2) == 0) && (uVar12 == 0)) {
      if (2 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___supdate_file_id__d__s_0105ea20,PTR_s_general_0105ea00,
                     PTR_s__INF__0105e9fc,PTR_s_ota_write_and_verify_file_0105ea08,
                     PTR_s__010f8ede_0x1b_0105e9f8,0,*(undefined1 *)(param_3 + 0xe),
                     PTR_s__010f8ede_0x1b_0105e9f8);
      }
    }
    else {
      uVar12 = *(uint *)(param_3 + 0x10) & 0xfffff000;
      iVar11 = uVar12 - *(uint *)(param_3 + 0x10);
      FUN_0105e7a0(param_1 + 0x14,param_2,uVar12 - *(int *)(param_2 + 0xc));
      if (2 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___supdate_file_id__d_w_0105ec4c,PTR_s_general_0105ec28,
                     PTR_s__INF__0105ec20,PTR_s_ota_write_and_verify_file_0105ec44,
                     PTR_s__010f8ede_0x1b_0105ec1c,*(undefined1 *)(param_3 + 0xe),
                     *(undefined4 *)(param_1 + 0x176),iVar11,PTR_s__010f8ede_0x1b_0105ec1c);
      }
      *(char *)(param_1 + 0x176) = (char)iVar11;
      *(char *)(param_1 + 0x177) = (char)((uint)iVar11 >> 8);
      *(char *)(param_1 + 0x178) = (char)((uint)iVar11 >> 0x10);
      *(char *)(param_1 + 0x179) = (char)((uint)iVar11 >> 0x18);
    }
  }
  if (1 < iVar4 - 5U) {
    FUN_01061c10(iVar7,param_3,2,iVar11,0);
    uVar9 = *(undefined4 *)(param_1 + 0x10);
    uVar10 = *(undefined4 *)(param_1 + 0x14);
    if (2 < *piVar2) {
      FUN_0104ba04(PTR_s___s__s__s___swrite_file__s_to_of_0105ec2c,PTR_s_general_0105ec28,
                   PTR_s__INF__0105ec20,PTR_s_ota_write_file_0105ec24,PTR_s__010f8ede_0x1b_0105ec1c,
                   param_3,*(undefined4 *)(param_3 + 0x10),PTR_s__010f8ede_0x1b_0105ec1c);
    }
    if (*(char *)(param_3 + 0xd) == '\x06') {
      if (2 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___ssugr_dsp_use_extern_0105ec34,PTR_s_general_0105ec28,
                     PTR_s__INF__0105ec20,PTR_s_ota_write_file_0105ec24,
                     PTR_s__010f8ede_0x1b_0105ec1c,PTR_s_sd_storage_0105ec30,
                     PTR_s__010f8ede_0x1b_0105ec1c);
      }
      uVar6 = 1;
    }
    else {
      uVar6 = 0;
    }
    FUN_01061504(uVar10,uVar6);
    iVar4 = FUN_01090054();
    uVar12 = *(uint *)(param_3 + 0x14);
    if (iVar11 < (int)uVar12) {
      iVar5 = func_0x000800d2(param_3);
      iVar13 = param_3;
      if (iVar5 == 0) {
        iVar13 = 0;
      }
      uVar8 = FUN_0106079c(uVar9,iVar13);
      if ((uVar8 & 0x80000000) == 0) {
        iStack_30 = uVar12 - iVar11;
        iVar13 = *(int *)(param_1 + 0x18);
        if (2 < *piVar2) {
          FUN_0104ba04(PTR_s___s__s__s___swlen____d_seg_size___0105ee10,PTR_s_general_0105ee04,
                       PTR_s__INF__0105ee14,PTR_s_ota_write_file_0105ee0c,
                       PTR_s__010f8ede_0x1b_0105edfc,iStack_30,iVar13,*(undefined1 *)(param_3 + 0xd)
                       ,PTR_s__010f8ede_0x1b_0105edfc);
        }
        for (; 0 < iStack_30; iStack_30 = iStack_30 - iVar13) {
          if (iStack_30 < iVar13) {
            iVar13 = iStack_30;
          }
          iVar5 = FUN_01061668(uVar10,CONCAT13(*(undefined1 *)(param_3 + 0x13),
                                               CONCAT12(*(undefined1 *)(param_3 + 0x12),
                                                        CONCAT11(*(undefined1 *)(param_3 + 0x11),
                                                                 *(undefined1 *)(param_3 + 0x10))))
                                      + iVar11,iVar13,*(undefined4 *)(param_1 + 0x1c),
                               *(undefined4 *)(param_1 + 0x18));
          if (iVar5 != 1) {
            FUN_0106c4e8(1,0x182,0x1eb,DAT_0105f014,2,iVar11,iVar13);
            goto LAB_0105eae2;
          }
          iVar5 = FUN_0106083c(uVar9,uVar8 + iVar11,*(undefined4 *)(param_1 + 0x1c),iVar13);
          if (iVar5 != 0) {
            FUN_0106c4e8(1,0x182,0x1f1,DAT_0105f018,1,iVar11);
            FUN_01061c10(iVar7,param_3,3,iVar11,1);
            iVar4 = -0xb;
            goto LAB_0105eedc;
          }
          FUN_01061c10(iVar7,param_3,3,iVar11,0);
          iVar5 = FUN_01061508(uVar10,*(int *)(param_3 + 0x10) + iVar11,
                               *(undefined4 *)(param_1 + 0x1c),iVar13);
          if (iVar5 != 0) {
            FUN_0106c4e8(1,0x182,0x1fa,DAT_0105f030,1,iVar11);
            iVar4 = -5;
            goto LAB_0105eedc;
          }
          iVar11 = iVar11 + iVar13;
        }
        iVar11 = FUN_01090054();
        puVar3 = PTR_s__010f8ede_0x1b_0105edfc;
        if (2 < *piVar2) {
          puVar14 = PTR_s__010f8ede_0x1b_0105edfc;
          uVar9 = func_0x0000050c(uVar12,iVar11 - iVar4);
          if ((uVar12 & 0x80000000) != 0) {
            uVar12 = uVar12 + 0x3ff;
          }
          FUN_0104ba04(PTR_s___s__s__s___swrite_file__s__leng_0105ee18,PTR_s_general_0105ee04,
                       PTR_s__INF__0105ee14,PTR_s_ota_write_file_0105ee0c,puVar3,param_3,
                       (int)uVar12 >> 10,iVar11 - iVar4,uVar9,puVar14);
        }
        if (((*(uint *)(param_1 + 8) & 4) == 0) || (*(char *)(param_2 + 8) != '\x01')) {
          FUN_01061c10(iVar7,param_3,5,0,0);
        }
        goto LAB_0105ed1e;
      }
      if (0 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___scannot_found_file___0105ee08,PTR_s_general_0105ee04,
                     PTR_s__ERR__0105ee00,PTR_s_ota_write_file_0105ee0c,
                     PTR_s__010f8ede_0x1b_0105edfc,param_3,PTR_s__010f8ede_0x1b_0105edfc);
      }
    }
    else if (0 < *piVar2) {
      FUN_0104ba04(PTR_s___s__s__s___sfile__s__start_file_0105ec38,PTR_s_general_0105ec28,
                   PTR_s__ERR__0105ec3c,PTR_s_ota_write_file_0105ec24,PTR_s__010f8ede_0x1b_0105ec1c,
                   param_3,iVar11,uVar12,PTR_s__010f8ede_0x1b_0105ec1c);
    }
LAB_0105eae2:
    iVar4 = -0x16;
LAB_0105eedc:
    if (0 < *piVar2) {
      FUN_0104ba04(PTR_s___s__s__s___sfailed_to_write_fil_0105f028,PTR_s_general_0105f024,
                   PTR_s__ERR__0105f020,PTR_s_ota_write_and_verify_file_0105f02c,
                   PTR_s__010f8ede_0x1b_0105f01c,param_3,PTR_s__010f8ede_0x1b_0105f01c);
    }
    if (iVar4 == -5) {
      return -5;
    }
    if (iVar4 == -0xb) {
      return -0xb;
    }
    goto LAB_0105ef06;
  }
LAB_0105ed1e:
  if (*(char *)(param_3 + 0xe) != -2) {
    uVar9 = *(undefined4 *)(param_1 + 0x14);
    FUN_01061504(uVar9,*(char *)(param_3 + 0xd) == '\x06');
    iVar4 = *(int *)(param_3 + 0x14);
    iStack_2c = *(int *)(param_3 + 0x10);
    if (2 < *piVar2) {
      FUN_0104ba04(PTR_s___s__s__s___scheck_file__s__addr_0105ee1c,PTR_s_general_0105ee04,
                   PTR_s__INF__0105ee14,PTR_s_ota_caculate_storage_file_crc_0105ee20,
                   PTR_s__010f8ede_0x1b_0105edfc,param_3,iStack_2c,iVar4,
                   PTR_s__010f8ede_0x1b_0105edfc);
    }
    iVar11 = *(int *)(param_1 + 0x18);
    iStack_30 = 0;
    for (; 0 < iVar4; iVar4 = iVar4 - iVar11) {
      if (iVar4 < iVar11) {
        iVar11 = iVar4;
      }
      FUN_010615d4(uVar9,iStack_2c,*(undefined4 *)(param_1 + 0x1c),iVar11);
      iStack_30 = FUN_0108dd4c(iStack_30,*(undefined4 *)(param_1 + 0x1c),iVar11);
      iStack_2c = iStack_2c + iVar11;
    }
    iVar4 = *(int *)(param_3 + 0x18);
    if (*piVar2 < 3) {
      if (iVar4 == iStack_30) goto LAB_0105efcc;
    }
    else {
      FUN_0104ba04(PTR_s___s__s__s___scheck_file__s__crc__0105ee24,PTR_s_general_0105ee04,
                   PTR_s__INF__0105ee14,PTR_s_ota_verify_file_0105ee28,PTR_s__010f8ede_0x1b_0105edfc
                   ,param_3,iVar4,iStack_30,PTR_s__010f8ede_0x1b_0105edfc);
      if (iVar4 == iStack_30) goto LAB_0105efb2;
    }
    if (0 < *piVar2) {
      FUN_0104ba04(PTR_s___s__s__s___sfile__s__verify_fai_0105ee2c,PTR_s_general_0105ee04,
                   PTR_s__ERR__0105ee00,PTR_s_ota_write_and_verify_file_0105ee30,
                   PTR_s__010f8ede_0x1b_0105edfc,param_3,PTR_s__010f8ede_0x1b_0105edfc);
    }
    if (((*(uint *)(param_1 + 8) & 4) == 0) || (*(char *)(param_2 + 8) != '\x01')) {
      FUN_01061c10(iVar7,param_3,0xf,0,0);
    }
    iVar4 = -1;
LAB_0105ef06:
    FUN_01061c10(iVar7,param_3,0xe,0,0);
    return iVar4;
  }
LAB_0105efb2:
  if (2 < *piVar2) {
    FUN_0104ba04(PTR_s___s__s__s___sfile__s__verify_pas_0105f038,PTR_s_general_0105f024,
                 PTR_s__INF__0105f034,PTR_s_ota_write_and_verify_file_0105f02c,
                 PTR_s__010f8ede_0x1b_0105f01c,param_3,PTR_s__010f8ede_0x1b_0105f01c);
  }
LAB_0105efcc:
  if (((*(uint *)(param_1 + 8) & 4) == 0) || (*(char *)(param_2 + 8) != '\x01')) {
    FUN_01061c10(iVar7,param_3,6,0,0);
  }
  return 0;
}



/* FUN_01002de4 @ 01002de4 */

void FUN_01002de4(void)

{
  uint *puVar1;
  undefined *puVar2;
  byte bVar3;
  uint uVar4;
  int iVar5;
  undefined4 uVar6;
  uint uVar7;
  
  puVar1 = DAT_01002eec;
  FUN_0103c5fc(PTR_s_dummy_watchdog_start_01002ee8);
  bVar3 = FUN_0105b354();
  *(byte *)puVar1 = (byte)*puVar1 & 0xbf | (bVar3 & 1) << 6;
  uVar4 = FUN_0105b4a8();
  puVar1[6] = uVar4;
  uVar4 = FUN_0105b438();
  puVar1[5] = uVar4;
  uVar4 = FUN_0105b3c8();
  puVar1[3] = uVar4;
  puVar1[4] = 0;
  FUN_0106cf6a(2000);
  iVar5 = FUN_0105a1c2();
  if ((DAT_01002ef0 < iVar5) || (iVar5 = FUN_0105a1cc(), iVar5 != 0)) {
    FUN_0105a1d8(PTR_LAB_01002ef8);
    FUN_01090810(DAT_01002f00,PTR_LAB_01002efc,0);
    FUN_01090848(DAT_01002f00,1000);
    uVar4 = FUN_01090054();
    uVar7 = *puVar1;
    *puVar1 = uVar7 & 0xfffc03ff;
    puVar1[7] = uVar4;
    uVar6 = DAT_01002f08;
    puVar2 = PTR_LAB_01002f04;
    *(byte *)((int)puVar1 + 2) = (byte)((uVar7 & 0xfffc03ff) >> 0x10) & 0xfb;
    FUN_01090810(uVar6,puVar2,0);
    FUN_01090848(DAT_01002f08,100,100);
    FUN_01090810(DAT_01002f10,PTR_LAB_01002f0c,0);
    FUN_01090848(DAT_01002f10,1000);
    FUN_01081498(PTR_LAB_01002f14);
    FUN_010814a4(PTR_LAB_01002f18);
    FUN_0100638c(0);
    FUN_01090810(DAT_01002f20,PTR_LAB_01002f1c,0);
    FUN_01090848(DAT_01002f20,0,200);
    FUN_0108fd2c(DAT_01002f24,0,1);
  }
  else {
    uVar6 = FUN_0105a1c2();
    FUN_0106c4e8(3,0x219,500,DAT_01002ef4,1,uVar6);
    FUN_0106d078();
  }
  return;
}



/* FUN_01002c2c @ 01002c2c */

void FUN_01002c2c(uint param_1)

{
  int iVar1;
  int iVar2;
  undefined4 uVar3;
  
  iVar1 = DAT_01002c54;
  if (DAT_01002c54 != 0) {
    iVar2 = FUN_0105b18c();
    if (iVar2 != 0) {
      FUN_01012fb8();
      FUN_0105b19c();
    }
    *(uint *)(iVar1 + 4) = *(uint *)(iVar1 + 4) | param_1;
    uVar3 = FUN_01090054();
    *(undefined4 *)(iVar1 + 0x1c) = uVar3;
  }
  return;
}



/* FUN_010042b0 @ 010042b0 */

void FUN_010042b0(void)

{
  byte *pbVar1;
  byte *pbVar2;
  char cVar3;
  undefined4 uVar4;
  uint uVar5;
  bool bVar6;
  int iVar7;
  undefined4 uVar8;
  undefined4 uVar9;
  
  cVar3 = FUN_0100e050();
  if ((byte)(cVar3 - 3U) < 2) {
    iVar7 = 0xc2;
    uVar8 = DAT_01004498;
  }
  else {
    iVar7 = FUN_0106cf5c();
    if (iVar7 == 0) {
      uVar9 = 0x197;
      uVar8 = DAT_010044a0;
      FUN_0106c4e8(3,0x21c,0x197,DAT_010044a0,1,0x197);
      FUN_01008308(1);
      FUN_0100feec(1);
      FUN_01004218();
      uVar4 = FUN_0106dd38();
      FUN_0106dd2c(uVar4,PTR_DAT_010044a4);
      FUN_0106dd20(10,PTR_DAT_010044a4);
      pbVar1 = DAT_010044a8;
      *(undefined4 *)(DAT_010044a8 + 0xc0) = uVar8;
      FUN_0106cffe(1);
      FUN_0106cfd0();
      pbVar1[0xc4] = pbVar1[0xc4] & 0xfb;
      FUN_0106d8d8();
      do {
        *pbVar1 = *pbVar1 | 4;
        uVar5 = func_0x00080630();
        if ((uVar5 & 0xd81e) == 0) {
          bVar6 = false;
        }
        else {
          if ((uVar5 & 0xc000) != 0) {
            pbVar1[0xc4] = pbVar1[0xc4] | 8;
          }
          FUN_0106cfd0();
          uVar9 = 0xd2;
          FUN_0106c4e8(3,0x21c,0xd2,DAT_010044ac,2,0xd2,uVar5);
          bVar6 = true;
        }
        if ((pbVar1[0xc4] & 2) != 0) {
          pbVar1[0xc4] = pbVar1[0xc4] & 0xfd;
LAB_010043b0:
          pbVar1[0xe8] = 0;
          pbVar1[0xe9] = 0;
          pbVar1[0xea] = 0;
          pbVar1[0xeb] = 0;
          FUN_0106c4e8(3,0x21c,0x11e,DAT_010044b0,1,0x11e);
          goto LAB_010043cc;
        }
        if (bVar6) goto LAB_010043b0;
        iVar7 = FUN_01072ea4();
        if (0 < iVar7) {
          FUN_0106c4e8(3,0x21c,0x125,DAT_010044b8,0,uVar9);
          goto LAB_010043cc;
        }
        if ((*(int *)(pbVar1 + 0xe8) != 0) &&
           (iVar7 = FUN_01090054(),
           (uint)(*(int *)(pbVar1 + 0xe0) * 1000) < (uint)(iVar7 - *(int *)(pbVar1 + 0xe8)))) {
          FUN_0106c4e8(3,0x21c,0x12f,DAT_010044bc,1,0x12f);
          pbVar2 = DAT_010044a8;
          if ((*pbVar1 & 2) == 0) {
            *pbVar1 = *pbVar1 | 2;
            *(uint *)(pbVar1 + 4) = *(uint *)(pbVar1 + 4) | 0x100;
            FUN_01003068(pbVar2);
          }
LAB_010043cc:
          FUN_0106d99c();
          *pbVar1 = *pbVar1 & 0xfb;
          FUN_0106dd2c(10,PTR_DAT_010044a4);
          FUN_0106dd20(uVar4,PTR_DAT_010044a4);
          FUN_0100fedc();
          FUN_01004258();
          FUN_0100feec(0);
          FUN_01008308(0);
          FUN_0106c4e8(3,0x21c,0x1bc,DAT_010044b4,1,0x1bc);
          return;
        }
        if (((*(int *)(pbVar1 + 0xe8) == 0) && ((pbVar1[0xc4] & 4) != 0)) &&
           (0x28 < *(uint *)(pbVar1 + 200))) {
          pbVar1[0xc4] = pbVar1[0xc4] & 0xfb;
          FUN_01004298();
          FUN_0106d8b8();
          FUN_010042a4();
        }
        uVar8 = *(undefined4 *)(pbVar1 + 0xc0);
        FUN_0105e170(300);
        *(undefined4 *)(pbVar1 + 0xc0) = uVar8;
      } while( true );
    }
    iVar7 = 199;
    uVar8 = DAT_0100449c;
  }
  FUN_0106c4e8(3,0x21c,iVar7 << 1,uVar8,0);
  return;
}



/* FUN_01004f6c @ 01004f6c */

void FUN_01004f6c(int param_1)

{
  char *pcVar1;
  byte *pbVar2;
  int *piVar3;
  undefined4 uVar4;
  undefined *puVar5;
  int iVar6;
  undefined4 uVar7;
  int iVar8;
  undefined1 uVar9;
  uint uVar10;
  undefined4 uVar11;
  byte bVar12;
  uint uVar13;
  undefined4 *puVar14;
  undefined4 uStack_14;
  
  uVar13 = (uint)*(byte *)(param_1 + 2);
  if (uVar13 < 0x8c) {
    if (0x89 < uVar13) goto LAB_01004fcc;
    if (uVar13 == 0x84) {
      uVar7 = FUN_01073168();
      iVar8 = func_0x000800b6(uVar7,PTR_s_udisk_0100517c,6);
      uVar9 = 0;
      puVar5 = PTR_s_udisk_0100517c;
      if (iVar8 == 0) {
        FUN_01003b50(0,0);
        puVar14 = (undefined4 *)0x0;
        uVar7 = 0x91;
        uVar4 = 0;
        puVar5 = PTR_DAT_01005170;
        goto LAB_010050c6;
      }
LAB_01005022:
      FUN_01003b50(puVar5,uVar9);
      return;
    }
    if (0x84 < uVar13) {
      uVar10 = uVar13 - 0x87;
      goto LAB_01004fc6;
    }
    if (uVar13 == 2) {
      FUN_0106c4e8(4,0x217,0x2a5,DAT_01005150,0);
      uVar9 = *(undefined1 *)(param_1 + 3);
      puVar5 = *(undefined **)(param_1 + 4);
      goto LAB_01005022;
    }
    if (uVar13 == 0x83) {
      FUN_01018150();
      return;
    }
  }
  else {
    if (uVar13 == 0xd6) {
      iVar8 = FUN_01051228();
      iVar6 = FUN_0105bc3c();
      iVar8 = (byte)~(iVar8 != 1) + 1;
      FUN_01051240(iVar8);
      if (iVar6 == 0) {
        return;
      }
      FUN_0105c11c(iVar6,iVar8);
      return;
    }
    if (uVar13 < 0xd7) {
      if (uVar13 == 0x8d) {
        iVar8 = FUN_0101300c();
        pcVar1 = DAT_01005154;
        if ((iVar8 == 0) && (*DAT_01005154 != '\0')) {
          *DAT_01005154 = '\0';
        }
        if (*pcVar1 == '\0') {
          return;
        }
        *pcVar1 = '\0';
        if (2 < *DAT_01005158) {
          FUN_0104ba04(PTR_s___s__s__s___sStop_sugr_noise_dem_01005168,
                       PTR_s_system_app_010e41e5_0xc_01005164,PTR_s__INF__01005160,
                       PTR_s_system_key_event_handle_0100516c,PTR_s__010f8ede_0x1b_0100515c,
                       PTR_s__010f8ede_0x1b_0100515c);
        }
        FUN_0105dbec(PTR_DAT_01005170,0,0x29,0,0);
        puVar14 = (undefined4 *)0x0;
        uVar7 = 0x4f;
        uVar4 = 0;
        puVar5 = PTR_s_sugr_app_0100514c;
LAB_010050c6:
        FUN_0105dbec(puVar5,0,uVar7,puVar14,uVar4);
        return;
      }
      if (uVar13 < 0x8d) {
        iVar8 = FUN_0101300c();
        pcVar1 = DAT_01005154;
        if ((iVar8 == 0) && (*DAT_01005154 != '\0')) {
          *DAT_01005154 = '\0';
        }
        if (*pcVar1 != '\0') {
          return;
        }
        *pcVar1 = '\x01';
        if (2 < *DAT_01005158) {
          FUN_0104ba04(PTR_s___s__s__s___sPlay_sugr_noise_dem_01005174,
                       PTR_s_system_app_010e41e5_0xc_01005164,PTR_s__INF__01005160,
                       PTR_s_system_key_event_handle_0100516c,PTR_s__010f8ede_0x1b_0100515c,
                       PTR_s__010f8ede_0x1b_0100515c);
        }
        FUN_01003a90(0x51);
        uStack_14 = DAT_01005178;
        uVar7 = 0x4e;
        uVar4 = 4;
        puVar14 = &uStack_14;
        puVar5 = PTR_s_sugr_app_0100514c;
        goto LAB_010050c6;
      }
      if (uVar13 == 0xc5) {
        FUN_01004d24();
        return;
      }
    }
    else {
      if (uVar13 == 0xd8) {
        uStack_14 = uStack_14 & 0xffffff00;
        iVar8 = FUN_01027ed4(2,&uStack_14);
        if (iVar8 != 0) {
          return;
        }
        uStack_14 = CONCAT31(uStack_14._1_3_,~((char)uStack_14 != '\0'));
        FUN_01027ba0(2,&uStack_14);
        return;
      }
      if (0xd7 < uVar13) {
        uVar10 = uVar13 - 0xde;
LAB_01004fc6:
        if (uVar10 < 2) {
LAB_01004fcc:
          FUN_01072e28(PTR_s_sugr_app_0100514c,param_1);
          return;
        }
      }
    }
  }
  if (uVar13 == 0xa5) {
    FUN_010085a0();
    FUN_0100fe98();
    return;
  }
  if (uVar13 < 0xa6) {
    if (uVar13 == 0x12) {
      FUN_01008ad0(0);
      return;
    }
    if (uVar13 < 0x13) {
      if (uVar13 == 0x11) {
        FUN_0106c4e8(3,0x217,0x1e1,DAT_010052f8,0);
        FUN_0100d8b8();
        return;
      }
    }
    else {
      if (uVar13 == 0x44) {
        FUN_0107471a(1);
        return;
      }
      if (uVar13 == 0xa4) {
        FUN_0100b24c();
        return;
      }
    }
  }
  else {
    if (uVar13 == 0xcc) {
      iVar8 = FUN_01004a38(PTR_s_linein_mix_plus_010052fc);
      piVar3 = DAT_01005304;
      if ((iVar8 != 0) && (*DAT_01005300 == '\x12')) {
        return;
      }
      iVar8 = FUN_01090054();
      if ((uint)(iVar8 - *piVar3) < 5000) {
        if (*DAT_010052e0 < 2) {
          return;
        }
        FUN_0104ba04(PTR_s___s__s__s___sskip_datat_type_swi_0100530c,
                     PTR_s_system_app_010e41e5_0xc_010052e8,PTR_s__WRN__01005308,
                     PTR_s_bt_switch_audio_data_type_01005310,PTR_s__010f8ede_0x1b_010052e4,
                     PTR_s__010f8ede_0x1b_010052e4);
        return;
      }
      iVar8 = FUN_01090054();
      *piVar3 = iVar8;
      iVar8 = FUN_0100e050();
      if ((iVar8 != 2) && (iVar8 = FUN_0100e050(), iVar8 != 4)) {
        FUN_0100e1b0(PTR_LAB_01005314);
        return;
      }
      uVar13 = FUN_0100e050();
      uVar11 = 0x1c3;
      uVar4 = 3;
      uVar7 = DAT_01005318;
      goto LAB_010052c8;
    }
    if (uVar13 < 0xcd) {
      if (uVar13 == 0xa6) {
        FUN_0100c480();
        return;
      }
      if (uVar13 == 0xcb) {
        FUN_01002d88();
        FUN_0107c100(0,0x39,0);
        return;
      }
    }
    else {
      if (uVar13 == 0xd3) {
        return;
      }
      if (uVar13 == 0xd7) {
        iVar8 = FUN_0105bc30();
        pbVar2 = DAT_010052dc;
        if (iVar8 == 0) {
          return;
        }
        bVar12 = *DAT_010052dc + 1;
        if (3 < bVar12) {
          bVar12 = 0;
        }
        *DAT_010052dc = bVar12;
        FUN_0105bb10(iVar8,0);
        FUN_0105bcd0(iVar8,*pbVar2);
        bVar12 = *pbVar2;
        uStack_14._0_2_ = CONCAT11(bVar12,1);
        if (2 < *DAT_010052e0) {
          FUN_0104ba04(PTR_s___s__s__s___s_d_s_010052ec,PTR_s_system_app_010e41e5_0xc_010052e8,
                       PTR_s__INF__010052f0,PTR_s_system_sync_remote_effect_peer_d_010052f4,
                       PTR_s__010f8ede_0x1b_010052e4,bVar12,PTR_s__010f8ede_0x1b_010052e4);
        }
        FUN_0100b848(0x28,&uStack_14,6,0);
        return;
      }
    }
  }
  uVar11 = 0x264;
  uVar4 = 1;
  uVar7 = DAT_01005148;
LAB_010052c8:
  FUN_0106c4e8(uVar4,0x217,uVar11,uVar7,1,uVar13);
  return;
}



/* FUN_010066b4 @ 010066b4 */

void FUN_010066b4(void)

{
  byte bVar1;
  int iVar2;
  undefined4 uVar3;
  undefined4 uVar4;
  uint uVar5;
  undefined4 uVar6;
  
  iVar2 = DAT_01006728;
  if ((*(byte *)(DAT_01006728 + 0x111) & 1) != 0) {
    FUN_010065f4();
    uVar3 = FUN_01090054();
    while( true ) {
      bVar1 = *(byte *)(iVar2 + 0x111);
      if ((bVar1 & 4) != 0) break;
      uVar4 = FUN_01090054();
      uVar5 = FUN_0105e1fc(uVar4,uVar3);
      if (5000 < uVar5) {
        uVar6 = 0x4c;
        uVar4 = 2;
        uVar3 = DAT_01006730;
        goto LAB_010066f8;
      }
      FUN_0108fad8(5);
    }
    *(byte *)(iVar2 + 0x111) = bVar1 & 0xfb;
    uVar6 = 0x47;
    uVar4 = 3;
    uVar3 = DAT_0100672c;
LAB_010066f8:
    FUN_0106c4e8(uVar4,0x1cd,uVar6,uVar3,0);
  }
  return;
}



/* FUN_0100c480 @ 0100c480 */

void FUN_0100c480(void)

{
  int iVar1;
  undefined4 uVar2;
  uint uVar3;
  
  iVar1 = FUN_0100653c(PTR_FUN_0100c4e0,0,0);
  if ((iVar1 == 0) && (iVar1 = FUN_01006a84(0xc), iVar1 != 0)) {
    FUN_0106c4e8(3,0x1cf,0x54,DAT_0100c4e4,1,*(undefined1 *)(iVar1 + 6));
    uVar2 = FUN_01090054();
    uVar3 = FUN_0105e1fc(uVar2,*(undefined4 *)(iVar1 + 0x254));
    if (1999 < uVar3) {
      uVar2 = FUN_01090054();
      *(undefined4 *)(iVar1 + 0x254) = uVar2;
      FUN_01006480(iVar1,0xe,0);
    }
  }
  return;
}



/* FUN_0100d9a8 @ 0100d9a8 */

int FUN_0100d9a8(int param_1)

{
  int *piVar1;
  int iVar2;
  int iVar3;
  undefined4 uVar4;
  undefined4 uVar5;
  uint uVar6;
  undefined2 auStack_50 [2];
  undefined1 uStack_4c;
  undefined1 auStack_48 [4];
  undefined4 uStack_44;
  byte abStack_40 [4];
  undefined1 uStack_3c;
  undefined2 *puStack_38;
  undefined1 *puStack_34;
  undefined4 uStack_28;
  undefined *puStack_20;
  int *piStack_1c;
  
  func_0x0008009e(abStack_40,0,0x2c);
  piVar1 = DAT_0100da94;
  abStack_40[0] = abStack_40[0] | 0x42;
  abStack_40[1] = 2;
  *DAT_0100da94 = param_1;
  uStack_3c = 1;
  piStack_1c = piVar1;
  uStack_4c = 0;
  auStack_50[0] = 1;
  puStack_38 = auStack_50;
  puStack_34 = auStack_48;
  auStack_48[0] = 0x10;
  uStack_44 = 0;
  uStack_28 = 0;
  puStack_20 = PTR_LAB_0100da98;
  iVar2 = FUN_0104cc18(abStack_40);
  if (iVar2 == 0) {
    FUN_0106c4e8(1,0x1ce,0x4b,DAT_0100da9c,1,0x4b);
    iVar2 = -1;
  }
  else {
    iVar3 = FUN_0105a24c(0x200);
    if (iVar3 == 0) {
      FUN_0105df80(PTR_s_sample_buf______void___0__0100daa4,0x50,PTR_s__010f8ede_0x1b_0100daa0);
    }
    FUN_0104cfa4(iVar2,iVar3,0x200);
    FUN_0104cea0(iVar2,1);
    uVar4 = FUN_01090054();
    do {
      if (*piVar1 == 0) break;
      FUN_0108fad8(1);
      uVar5 = FUN_01090054();
      uVar6 = FUN_0105e1fc(uVar5,uVar4);
    } while (uVar6 < 6000);
    FUN_0104ced0(iVar2);
    FUN_0104ce58(iVar2);
    FUN_0105a260(iVar3);
    iVar2 = piVar1[1];
  }
  return iVar2;
}



/* FUN_0100daa8 @ 0100daa8 */

int FUN_0100daa8(int param_1)

{
  int *piVar1;
  int iVar2;
  int iVar3;
  undefined4 uVar4;
  undefined4 uVar5;
  uint uVar6;
  undefined2 uStack_4c;
  undefined1 uStack_4a;
  undefined2 auStack_48 [2];
  undefined1 uStack_44;
  byte abStack_40 [4];
  undefined1 uStack_3c;
  undefined2 *puStack_38;
  undefined2 *puStack_30;
  undefined4 uStack_28;
  undefined *puStack_20;
  int *piStack_1c;
  
  uStack_4c = 0;
  uStack_4a = 0;
  func_0x0008009e(abStack_40,0,0x2c);
  piVar1 = DAT_0100dba4;
  abStack_40[0] = abStack_40[0] | 0x42;
  abStack_40[1] = 2;
  *DAT_0100dba4 = param_1;
  uStack_3c = 10;
  piStack_1c = piVar1;
  uStack_44 = 0;
  auStack_48[0] = 1;
  puStack_38 = auStack_48;
  uStack_4c = 0x30;
  uStack_4a = 0;
  puStack_30 = &uStack_4c;
  uStack_28 = 0;
  puStack_20 = PTR_LAB_0100dba8;
  iVar2 = FUN_0104cc18(abStack_40);
  if (iVar2 == 0) {
    FUN_0106c4e8(1,0x1ce,0x93,DAT_0100dbac,1,0x93);
    iVar2 = -1;
  }
  else {
    iVar3 = FUN_0105a24c(0x200);
    if (iVar3 == 0) {
      FUN_0105df80(PTR_s_sample_buf______void___0__0100dbb4,0x98,PTR_s__010f8ede_0x1b_0100dbb0);
    }
    FUN_0104cfa4(iVar2,iVar3,0x200);
    FUN_0104cea0(iVar2,1);
    uVar4 = FUN_01090054();
    do {
      if (*piVar1 == 0) break;
      FUN_0108fad8(1);
      uVar5 = FUN_01090054();
      uVar6 = FUN_0105e1fc(uVar5,uVar4);
    } while (uVar6 < 6000);
    FUN_0104ced0(iVar2);
    FUN_0104ce58(iVar2);
    FUN_0105a260(iVar3);
    iVar2 = piVar1[1];
  }
  return iVar2;
}



/* FUN_0101a758 @ 0101a758 */

uint FUN_0101a758(undefined4 *param_1)

{
  undefined *puVar1;
  int *piVar2;
  int iVar3;
  int iVar4;
  int iVar5;
  int iVar6;
  uint uVar7;
  undefined4 uVar8;
  undefined4 uVar9;
  uint uVar10;
  uint uVar11;
  undefined *puVar12;
  uint uStack_34;
  uint uStack_30;
  int iStack_2c;
  
  piVar2 = DAT_0101a8b4;
  uVar8 = *param_1;
  iVar3 = FUN_01090054();
  iVar4 = FUN_01018c18(4);
  if (iVar4 == 0) {
    iVar3 = *piVar2;
    puVar1 = PTR_s___s__s__s___scannot_found_part_i_0101a8c8;
  }
  else {
    iVar5 = FUN_01018c64(uVar8,iVar4);
    if (iVar5 == 0) {
      if (param_1[2] == 0) {
        iVar5 = FUN_0105a24c(param_1[1]);
        param_1[2] = iVar5;
        if (iVar5 == 0) {
          if (0 < *piVar2) {
            FUN_0104ba04(PTR_s___s__s__s___sfaield_to_allocate___0101a8d0,PTR_s_general_0101a8c4,
                         PTR_s__ERR__0101a8bc,PTR_s_ota_app_sugr_upgrade_sdfs_part_0101a8c0,
                         PTR_s__010f8ede_0x1b_0101a8b8,param_1[1],PTR_s__010f8ede_0x1b_0101a8b8);
          }
          uVar10 = 0xfffffff4;
          goto LAB_0101a780;
        }
      }
      uStack_30 = *(uint *)(iVar4 + 0x10);
      uVar11 = param_1[1];
      if (2 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___swlen____d_seg_size___0101a8d4,PTR_s_general_0101a8c4,
                     PTR_s__INF__0101a8d8,PTR_s_ota_app_sugr_upgrade_sdfs_part_0101a8c0,
                     PTR_s__010f8ede_0x1b_0101a8b8,uStack_30,uVar11,*(undefined1 *)(iVar4 + 8),
                     PTR_s__010f8ede_0x1b_0101a8b8);
      }
      puVar12 = PTR_s_SD__sdfs_bin_0101a8dc;
      puVar1 = PTR_s__010f8ede_0x1b_0101a8b8;
      uStack_34 = 0;
      for (; uVar9 = param_1[2], 0 < (int)uStack_30; uStack_30 = uStack_30 - uVar11) {
        uVar10 = uVar11;
        if ((int)uStack_30 < (int)uVar11) {
          uVar10 = uStack_30;
        }
        iVar5 = FUN_01018940(uVar8,iVar4,uStack_34,uVar10,uVar9,param_1[1]);
        if (iVar5 != 1) {
          if (0 < *piVar2) {
            FUN_0104ba04(PTR_s___s__s__s___sstorage_is_not_clea_0101aaa4,PTR_s_general_0101aaa0,
                         PTR_s__ERR__0101aaa8,PTR_s_ota_app_sugr_upgrade_sdfs_part_0101aaac,
                         PTR_s__010f8ede_0x1b_0101aa9c,uStack_34,uVar10,
                         PTR_s__010f8ede_0x1b_0101aa9c);
          }
          goto LAB_0101a77c;
        }
        uVar9 = param_1[2];
        iVar5 = FUN_0105a24c(0x40);
        if (iVar5 == 0) {
          if (*piVar2 < 1) {
            uVar10 = 0xffffffff;
          }
          else {
            uVar11 = 0xffffffff;
            FUN_0104ba04(PTR_s___s__s__s___s_s__d__err_fs_mallo_0101aab4,PTR_s_general_0101aaa0,
                         PTR_s__ERR__0101aaa8,PTR_s_ota_app_sugr_read_sdfs_file_0101aab0,
                         PTR_s__010f8ede_0x1b_0101aa9c,PTR_s_ota_app_sugr_read_sdfs_file_0101aab0,
                         0x799,PTR_s__010f8ede_0x1b_0101aa9c);
LAB_0101a964:
            iVar3 = *piVar2;
            uVar10 = uVar11;
            puVar1 = PTR_s___s__s__s___sCannot_read_data_fr_0101aab8;
joined_r0x0101a968:
            if (0 < iVar3) {
              FUN_0104ba04(puVar1,PTR_s_general_0101aaa0,PTR_s__ERR__0101aaa8,
                           PTR_s_ota_app_sugr_upgrade_sdfs_part_0101aaac,
                           PTR_s__010f8ede_0x1b_0101aa9c,uStack_34,PTR_s__010f8ede_0x1b_0101aa9c);
            }
          }
          goto LAB_0101a780;
        }
        iVar6 = FUN_01066948(iVar5,PTR_s_SD__sdfs_bin_0101aabc);
        if (iVar6 == 0) {
          iVar6 = FUN_01066a00(iVar5,uStack_34,0);
          if (iVar6 != 0) {
            if (0 < *piVar2) {
              FUN_0104ba04(PTR_s___s__s__s___sError_seek_file_s_0101aac4,PTR_s_general_0101aaa0,
                           PTR_s__ERR__0101aaa8,PTR_s_ota_app_sugr_read_sdfs_file_0101aab0,puVar1,
                           puVar1);
            }
            goto LAB_0101aa06;
          }
          uVar11 = FUN_010669a8(iVar5,uVar9,uVar10);
          if (uVar11 == 0) {
            if (0 < *piVar2) {
              FUN_0104ba04(PTR_s___s__s__s___sread_error__read_le_0101aac8,PTR_s_general_0101aaa0,
                           PTR_s__ERR__0101aaa8,PTR_s_ota_app_sugr_read_sdfs_file_0101aab0,puVar1,0,
                           puVar1);
            }
            goto LAB_0101aa06;
          }
          if (2 < *piVar2) {
            FUN_0104ba04(PTR_s___s__s__s___sread_datalen____d_s_0101aad0,PTR_s_general_0101aaa0,
                         PTR_s__INF__0101aacc,PTR_s_ota_app_sugr_read_sdfs_file_0101aab0,puVar1,
                         uVar11,puVar1);
          }
        }
        else {
          if (0 < *piVar2) {
            FUN_0104ba04(PTR_s___s__s__s___scannot_open__s_file_0101aac0,PTR_s_general_0101aaa0,
                         PTR_s__ERR__0101aaa8,PTR_s_ota_app_sugr_read_sdfs_file_0101aab0,puVar1,
                         puVar12,iVar6,puVar1);
          }
LAB_0101aa06:
          uVar11 = 0xffffffff;
        }
        FUN_01066968(iVar5);
        FUN_0105a260(iVar5);
        if ((int)uVar11 < 1) goto LAB_0101a964;
        if (uVar11 != uVar10) {
          uStack_30 = uVar11;
        }
        uVar10 = FUN_01018aa0(uVar8,iVar4,uStack_34,param_1[2],uVar11);
        if (uVar10 != 0) {
          iVar3 = *piVar2;
          puVar1 = PTR_s___s__s__s___sstorage_write_faile_0101aad4;
          goto joined_r0x0101a968;
        }
        uStack_34 = uStack_34 + uVar11;
      }
      iVar5 = FUN_0105a24c(0x40);
      puVar1 = PTR_s_SD__sdfs_bin_0101aabc;
      if (iVar5 == 0) {
        if (0 < *piVar2) {
          FUN_0104ba04(PTR_s___s__s__s___s_s__d__err_fs_mallo_0101a8e4,PTR_s_general_0101a8c4,
                       PTR_s__ERR__0101a8bc,PTR_s_ota_app_sugr_verify_sdfs_0101a8e0,
                       PTR_s__010f8ede_0x1b_0101a8b8,PTR_s_ota_app_sugr_verify_sdfs_0101a8e0,0x7cc,
                       PTR_s__010f8ede_0x1b_0101a8b8);
        }
LAB_0101a896:
        if (0 < *piVar2) {
          FUN_0104ba04(PTR_s___s__s__s___sfile__s__verify_fai_0101a8e8,PTR_s_general_0101a8c4,
                       PTR_s__ERR__0101a8bc,PTR_s_ota_app_sugr_upgrade_sdfs_part_0101a8c0,
                       PTR_s__010f8ede_0x1b_0101a8b8,iVar4,PTR_s__010f8ede_0x1b_0101a8b8);
        }
        uVar10 = 1;
      }
      else {
        iVar6 = FUN_01066948(iVar5,PTR_s_SD__sdfs_bin_0101aabc);
        if (iVar6 != 0) {
          if (0 < *piVar2) {
            FUN_0104ba04(PTR_s___s__s__s___scannot_open__s_file_0101ac5c,PTR_s_general_0101aaa0,
                         PTR_s__ERR__0101ac60,PTR_s_ota_app_sugr_verify_sdfs_0101ac64,
                         PTR_s__010f8ede_0x1b_0101aa9c,puVar1,PTR_s__010f8ede_0x1b_0101aa9c);
          }
LAB_0101aaea:
          FUN_01066968(iVar5);
          FUN_0105a260(iVar5);
          goto LAB_0101a896;
        }
        iVar6 = FUN_01066a00(iVar5,0,0);
        if (iVar6 != 0) {
          if (0 < *piVar2) {
            FUN_0104ba04(PTR_s___s__s__s___sError_seek_file_s_0101ac84,PTR_s_general_0101ac6c,
                         PTR_s__ERR__0101ac60,PTR_s_ota_app_sugr_verify_sdfs_0101ac64,
                         PTR_s__010f8ede_0x1b_0101ac68,PTR_s__010f8ede_0x1b_0101ac68);
          }
          goto LAB_0101aaea;
        }
        uStack_30 = 0;
        while (iVar6 = FUN_010669a8(iVar5,uVar9,uVar11), iVar6 != 0) {
          uStack_30 = FUN_0108dd4c(uStack_30,uVar9,iVar6);
        }
        uVar10 = *(uint *)(iVar5 + 0x28);
        if (2 < *piVar2) {
          FUN_0104ba04(PTR_s___s__s__s___scrc_orig_0x_x__file_0101ac70,PTR_s_general_0101ac6c,
                       PTR_s__INF__0101ac74,PTR_s_ota_app_sugr_verify_sdfs_0101ac64,
                       PTR_s__010f8ede_0x1b_0101ac68,uStack_30,uVar10,PTR_s__010f8ede_0x1b_0101ac68)
          ;
        }
        FUN_01066968(iVar5);
        FUN_0105a260(iVar5);
        iVar5 = *(int *)(iVar4 + 0xc);
        uVar7 = FUN_01061500(uVar8);
        if (uVar7 != *(byte *)(iVar4 + 10) >> 4) {
          FUN_01061504(uVar8);
        }
        iStack_2c = 0;
        uStack_34 = uVar11;
        for (; uVar10 != 0; uVar10 = uVar10 - uStack_34) {
          if (uVar10 < uStack_34) {
            uStack_34 = uVar10;
          }
          FUN_010615d4(uVar8,iVar5,uVar9);
          iStack_2c = FUN_0108dd4c(iStack_2c,uVar9,uStack_34);
          iVar5 = iVar5 + uStack_34;
        }
        FUN_01061504(uVar8,uVar7 & 0xff);
        if (2 < *piVar2) {
          FUN_0104ba04(PTR_s___s__s__s___scheck__s__crc_calc_0_0101ac78,PTR_s_general_0101ac6c,
                       PTR_s__INF__0101ac74,PTR_s_ota_app_sugr_verify_sdfs_0101ac64,
                       PTR_s__010f8ede_0x1b_0101ac68,iVar4,iStack_2c,PTR_s__010f8ede_0x1b_0101ac68);
        }
        uVar10 = 0;
        if (uStack_30 != iStack_2c) goto LAB_0101a896;
      }
      iVar5 = FUN_01090054();
      puVar1 = PTR_s__010f8ede_0x1b_0101ac68;
      if (2 < *piVar2) {
        uVar11 = *(uint *)(iVar4 + 0x10);
        puVar12 = PTR_s__010f8ede_0x1b_0101ac68;
        uVar8 = func_0x0000050c(uVar11,iVar5 - iVar3);
        FUN_0104ba04(PTR_s___s__s__s___swrite_part__s__leng_0101ac80,PTR_s_general_0101ac6c,
                     PTR_s__INF__0101ac74,PTR_s_ota_app_sugr_upgrade_sdfs_part_0101ac7c,puVar1,iVar4
                     ,uVar11 >> 10,iVar5 - iVar3,uVar8,puVar12);
      }
      goto LAB_0101a780;
    }
    iVar3 = *piVar2;
    puVar1 = PTR_s___s__s__s___scannot_erase_relate_0101a8cc;
  }
  if (0 < iVar3) {
    FUN_0104ba04(puVar1,PTR_s_general_0101a8c4,PTR_s__ERR__0101a8bc,
                 PTR_s_ota_app_sugr_upgrade_sdfs_part_0101a8c0,PTR_s__010f8ede_0x1b_0101a8b8,4,
                 PTR_s__010f8ede_0x1b_0101a8b8);
  }
LAB_0101a77c:
  uVar10 = 0xffffffea;
LAB_0101a780:
  if (param_1[2] != 0) {
    FUN_0105a260();
    param_1[2] = 0;
  }
  return uVar10;
}



/* FUN_0102478c @ 0102478c */

undefined4 FUN_0102478c(int param_1,int *param_2)

{
  int *piVar1;
  undefined *puVar2;
  undefined4 uVar3;
  int iVar4;
  int iVar5;
  undefined *puVar6;
  
  puVar2 = PTR_s__010f8ede_0x1b_01024888;
  piVar1 = DAT_01024884;
  iVar4 = *DAT_01024880;
  if (iVar4 == 0) {
    if (0 < *DAT_01024884) {
      FUN_0104ba04(PTR_s___s__s__s___spowermgr_no_init__s_01024894,PTR_s_general_01024890,
                   PTR_s__ERR__0102488c,PTR_s_power_mgr_setoption_01024898,
                   PTR_s__010f8ede_0x1b_01024888,PTR_s__010f8ede_0x1b_01024888);
    }
  }
  else {
    if (param_1 == 3) {
      uVar3 = FUN_01090054();
      *(undefined4 *)(iVar4 + 0xc) = uVar3;
      return 0;
    }
    if (*DAT_01024884 < 3) {
      if (param_1 == 0) goto LAB_01024844;
    }
    else {
      puVar6 = PTR_s__010f8ede_0x1b_01024888;
      FUN_0104ba04(PTR_s___s__s__s___spowermgr_setoption__010248a0,PTR_s_general_01024890,
                   PTR_s__INF__0102489c,PTR_s_power_mgr_setoption_01024898,
                   PTR_s__010f8ede_0x1b_01024888,param_1,PTR_s__010f8ede_0x1b_01024888);
      if (param_1 == 0) {
        iVar4 = *DAT_01024880;
        if (iVar4 == 0) {
          if (*piVar1 < 1) {
            return 0xffffffff;
          }
          FUN_0104ba04(PTR_s___s__s__s___spower_no_init__s_010248a4,PTR_s_general_01024890,
                       PTR_s__ERR__0102488c,PTR_s_power_mgr_system_enable_010248a8,puVar2,puVar2,
                       puVar6);
          return 0xffffffff;
        }
LAB_01024844:
        iVar5 = *param_2;
        uVar3 = (*(code *)(*(uint *)(*(int *)(*(int *)(iVar4 + 0x14) + 4) + 4) & 0xfffffffe))
                          (*(int *)(iVar4 + 0x14),0,0x33,iVar5 != 0);
        if (2 < *piVar1) {
          FUN_0104ba04(PTR_s___s__s__s___s_s__d__sys_power____010248b4,PTR_s_general_01024890,
                       PTR_s__INF__0102489c,PTR_s_power_mgr_system_enable_010248a8,
                       PTR_s__010f8ede_0x1b_01024888,PTR_s_power_mgr_system_enable_010248a8,0xa2,
                       iVar5,PTR_s__010f8ede_0x1b_01024888);
          return uVar3;
        }
        return uVar3;
      }
    }
    if (1 < *piVar1) {
      FUN_0104ba04(PTR_s___s__s__s___s_s__d__undefined__s_010248b0,PTR_s_general_01024890,
                   PTR_s__WRN__010248ac,PTR_s_power_mgr_setoption_01024898,
                   PTR_s__010f8ede_0x1b_01024888,PTR_s_power_mgr_setoption_01024898,0x4cc,
                   PTR_s__010f8ede_0x1b_01024888);
    }
  }
  return 0xffffffff;
}



/* FUN_01059bec @ 01059bec */

undefined4 FUN_01059bec(undefined4 param_1)

{
  int *piVar1;
  int iVar2;
  undefined4 uVar3;
  
  piVar1 = DAT_01059cd4;
  iVar2 = FUN_0105a24c(0x78);
  *piVar1 = iVar2;
  if (iVar2 == 0) {
    FUN_0106c4e8(1,0xd7,0x168,PTR_DAT_01059cd8,1,0x78);
  }
  else {
    FUN_01090e88(iVar2,PTR_LAB_01059cdc);
    FUN_01090e88(*piVar1 + 0x28,PTR_LAB_01059ce0);
    iVar2 = *piVar1;
    *(undefined4 *)(iVar2 + 0x50) = param_1;
    *(undefined1 *)(iVar2 + 0x74) = 1;
    iVar2 = FUN_0104d5d0(PTR_LAB_01059ce4,PTR_s_adckey_01059ce8);
    if (iVar2 != 0) {
      iVar2 = FUN_0104d5d0(PTR_LAB_01059ce4,PTR_s_onoff_key_01059cf0);
      if (iVar2 == 0) {
        FUN_0106c4e8(1,0xd7,0x17b,PTR_DAT_01059cf4,0);
      }
      iVar2 = FUN_0104d5d0(PTR_LAB_01059ce4,PTR_s_gpiokey_01059cf8);
      if (iVar2 == 0) {
        FUN_0106c4e8(1,0xd7,0x181,PTR_DAT_01059cec,0);
      }
      iVar2 = FUN_0104d5d0(PTR_LAB_01059ce4,PTR_s_encoder_key_01059cfc);
      if (iVar2 == 0) {
        FUN_0106c4e8(1,0xd7,0x196,PTR_DAT_01059cec,0);
      }
      uVar3 = FUN_01090054();
      FUN_0106c4e8(3,0xd7,0x19a,PTR_DAT_01059d00,1,uVar3);
      return 1;
    }
    FUN_0106c4e8(1,0xd7,0x174,PTR_DAT_01059cec,0);
    FUN_0105a260(*piVar1);
  }
  return 0;
}



/* FUN_01004524 @ 01004524 */

void FUN_01004524(void)

{
  byte bVar1;
  byte *pbVar2;
  byte *pbVar3;
  int iVar4;
  undefined4 uVar5;
  int iVar6;
  
  pbVar2 = DAT_01004614;
  if ((DAT_01004614[0xc4] & 2) == 0) {
    if (*(int *)(DAT_01004614 + 0x28) == 0) {
      if ((*DAT_01004614 & 2) == 0) {
        bVar1 = *(byte *)(DAT_0100461c + 200);
        if ((bVar1 & 0x10) == 0) {
          if ((bVar1 & 4) == 0) {
            if ((bVar1 & 2) == 0) {
              iVar6 = *(int *)(DAT_01004614 + 0x10);
              iVar4 = FUN_0105c0cc();
              if (iVar4 == 0) {
                iVar4 = FUN_01002f98();
                if (iVar4 == 0) {
                  pbVar2[0xe8] = 0;
                  pbVar2[0xe9] = 0;
                  pbVar2[0xea] = 0;
                  pbVar2[0xeb] = 0;
                  if (iVar6 == 0) {
                    pbVar2[0xe4] = 0;
                    pbVar2[0xe5] = 0;
                    pbVar2[0xe6] = 0;
                    pbVar2[0xe7] = 0;
                    return;
                  }
                  if (*(int *)(pbVar2 + 0xe4) == 0) {
                    uVar5 = FUN_01090054();
                    *(undefined4 *)(pbVar2 + 0xe4) = uVar5;
                    return;
                  }
                  iVar4 = FUN_01090054();
                  pbVar3 = DAT_01004614;
                  if (iVar6 < 10) {
                    iVar6 = 10;
                  }
                  if ((uint)(iVar4 - *(int *)(pbVar2 + 0xe4)) <= (uint)(iVar6 * 1000)) {
                    return;
                  }
                  pbVar2[0xe4] = 0;
                  pbVar2[0xe5] = 0;
                  pbVar2[0xe6] = 0;
                  pbVar2[0xe7] = 0;
                  *(uint *)(pbVar2 + 4) = *(uint *)(pbVar2 + 4) | 0x200;
                  FUN_01003068(pbVar3);
                  return;
                }
                uVar5 = 9;
              }
              else {
                uVar5 = 7;
              }
            }
            else {
              uVar5 = 6;
            }
          }
          else {
            uVar5 = 5;
          }
        }
        else {
          uVar5 = 4;
        }
      }
      else {
        uVar5 = 3;
      }
    }
    else {
      uVar5 = 2;
    }
  }
  else {
    FUN_010041f0(0);
    uVar5 = 1;
  }
  FUN_0106c4e8(4,0x21c,0x280,DAT_01004618,2,0x280,uVar5);
  pbVar2[0xe4] = 0;
  pbVar2[0xe5] = 0;
  pbVar2[0xe6] = 0;
  pbVar2[0xe7] = 0;
  pbVar2[0xe8] = 0;
  pbVar2[0xe9] = 0;
  pbVar2[0xea] = 0;
  pbVar2[0xeb] = 0;
  return;
}



/* FUN_010039e4 @ 010039e4 */

void FUN_010039e4(uint param_1,undefined4 param_2)

{
  int *piVar1;
  int iVar2;
  int iVar3;
  int iVar4;
  int iStack_1c;
  int iStack_18;
  
  iVar2 = FUN_01090054();
  piVar1 = DAT_01003a6c;
  if (param_1 == 0x2b) {
    iVar2 = FUN_01090054();
    *DAT_01003a6c = iVar2;
  }
  else if (param_1 == 0x21) {
    iVar4 = *DAT_01003a6c;
    iVar3 = FUN_01090054();
    *piVar1 = iVar3;
    FUN_0106c4e8(3,0x21f,0x38,DAT_01003a70,1,iVar2 - iVar4);
    if ((uint)(iVar2 - iVar4) < 0x5dc) {
      return;
    }
  }
  iStack_1c = 0;
  FUN_0102d828(0x15,&iStack_1c);
  iStack_18 = 0;
  FUN_01027ed4(1,&iStack_18);
  if ((iStack_18 == 4) && (((iStack_1c == 0 || (param_1 == 0x51)) || (0x56 < param_1)))) {
    FUN_01004620(param_1,param_2);
  }
  return;
}



/* FUN_0100b580 @ 0100b580 */

undefined4 FUN_0100b580(int param_1)

{
  undefined4 uVar1;
  int iVar2;
  uint uVar3;
  int iVar4;
  undefined4 uVar5;
  bool bVar6;
  
  uVar1 = FUN_01090054();
  while (iVar2 = FUN_0100bcd4(), iVar2 == 0) {
    uVar5 = FUN_01090054();
    uVar3 = FUN_0105e1fc(uVar5,uVar1);
    if (100 < uVar3) {
      return 1;
    }
    FUN_0108fad8(10);
  }
  iVar2 = FUN_0100e050();
  if (iVar2 == 3) {
    return 1;
  }
  iVar2 = FUN_0100e050();
  if (iVar2 == 4) {
    return 1;
  }
  if (*(char *)(param_1 + 7) == '\0') {
    return 1;
  }
  iVar2 = FUN_0100bcd4();
  if (iVar2 == 2) {
    uVar3 = FUN_01006b88();
    if (0 < (int)uVar3) {
      FUN_0100b9ac(1,uVar3 & 0xff,0);
      uVar1 = FUN_01090054();
      while (*(char *)(param_1 + 0x154) == -1) {
        uVar5 = FUN_01090054();
        uVar3 = FUN_0105e1fc(uVar5,uVar1);
        if (3000 < uVar3) {
          uVar5 = 0x218;
          uVar1 = DAT_0100b78c;
          goto LAB_0100b65c;
        }
        FUN_0108fad8(10);
      }
    }
    if ((byte)(*(char *)(param_1 + 0x154) - 1U) < 0xfe) {
      iVar2 = 1;
      FUN_0106c4e8(3,0x1e1,0x252,DAT_0100b784,0);
      *DAT_0100b788 = 1;
      *(byte *)(param_1 + 10) = *(byte *)(param_1 + 10) | 2;
      FUN_010064e4(param_1,0x20,0);
      FUN_0108fad8(100);
      FUN_010064e4(param_1,0x1f,1);
LAB_0100b710:
      uVar1 = FUN_01090054();
      while( true ) {
        iVar4 = FUN_0100bcd4();
        if (iVar2 == iVar4) {
          FUN_0106c4e8(3,0x1e1,0x282,DAT_0100b798,0);
          *DAT_0100b788 = 0;
          *(byte *)(param_1 + 10) = *(byte *)(param_1 + 10) & 0xfd;
          return 1;
        }
        uVar5 = FUN_01090054();
        uVar3 = FUN_0105e1fc(uVar5,uVar1);
        if (3000 < uVar3) break;
        FUN_0108fad8(10);
      }
      if (((*(byte *)(param_1 + 8) & 2) == 0) && (*(char *)(param_1 + 0x70) != '\0')) {
        *(char *)(param_1 + 0x70) = *(char *)(param_1 + 0x70) + -1;
      }
      uVar5 = 0x27b;
      uVar1 = DAT_0100b7d8;
LAB_0100b65c:
      iVar4 = param_1 + 0x218;
      FUN_0106c4e8(3,0x1e1,uVar5,uVar1,0);
      iVar2 = FUN_0109094c(iVar4);
      if (iVar2 == 0) {
        *DAT_0100b788 = 0;
        *(byte *)(param_1 + 10) = *(byte *)(param_1 + 10) & 0xfd;
        FUN_010083b4(0,0);
        FUN_01008cb0(param_1);
        FUN_01090810(iVar4,PTR_LAB_0100b790,param_1);
        FUN_01090848(iVar4,0,100);
      }
      return 0;
    }
  }
  else if (iVar2 == 1) {
    iVar2 = FUN_01006b88();
    uVar1 = FUN_01090054();
    while (iVar2 == 0) {
      if (*(char *)(param_1 + 0x154) != -1) {
LAB_0100b76c:
        bVar6 = (byte)(*(char *)(param_1 + 0x154) - 1U) < 0xfe;
        goto LAB_0100b6de;
      }
      iVar2 = FUN_01006b88();
      uVar5 = FUN_01090054();
      uVar3 = FUN_0105e1fc(uVar5,uVar1);
      if (1000 < uVar3) {
        if (iVar2 == 0) goto LAB_0100b76c;
        break;
      }
      FUN_0108fad8(10);
    }
    bVar6 = false;
LAB_0100b6de:
    FUN_0100b9ac(1,bVar6,0);
    if (bVar6 != false) {
      iVar2 = 2;
      FUN_0106c4e8(3,0x1e1,0x252,DAT_0100b784,0);
      *DAT_0100b788 = 1;
      *(byte *)(param_1 + 10) = *(byte *)(param_1 + 10) | 2;
      goto LAB_0100b710;
    }
  }
  FUN_0106c4e8(3,0x1e1,0x24c,DAT_0100b794,0);
  return 1;
}



/* FUN_0100c628 @ 0100c628 */

void FUN_0100c628(int param_1)

{
  undefined4 uVar1;
  uint uVar2;
  
  FUN_0106c4e8(3,0x1cf,0xa4,DAT_0100c670,1,*(undefined1 *)(param_1 + 6));
  uVar1 = FUN_01090054();
  uVar2 = FUN_0105e1fc(uVar1,*(undefined4 *)(param_1 + 0x254));
  if (1999 < uVar2) {
    uVar1 = FUN_01090054();
    *(undefined4 *)(param_1 + 0x254) = uVar1;
    FUN_01006480(param_1,0x14,0);
  }
  return;
}



/* FUN_0102c21c @ 0102c21c */

undefined4 FUN_0102c21c(void)

{
  int *piVar1;
  int *piVar2;
  undefined4 uVar3;
  int iVar4;
  int iVar5;
  undefined2 uStack_18;
  undefined1 uStack_16;
  undefined1 uStack_15;
  undefined1 uStack_13;
  undefined1 uStack_12;
  undefined1 uStack_11;
  
  piVar1 = DAT_0102c2f8;
  uVar3 = FUN_01090054();
  iVar4 = func_0x0000050c(uVar3,1000);
  iVar5 = *piVar1;
  if (iVar5 == 0) {
    if (0 < *DAT_0102c2fc) {
      FUN_0104ba04(PTR_s___s__s__s___srecord_no_init_s_0102c30c,PTR_s_general_0102c308,
                   PTR_s__ERR__0102c304,PTR_s_record_mgr_update_systime_0102c310,
                   PTR_s__010f8ede_0x1b_0102c300,PTR_s__010f8ede_0x1b_0102c300);
    }
  }
  else if (iVar4 != *(int *)(iVar5 + 0x20)) {
    *(int *)(iVar5 + 0x20) = iVar4;
    iVar4 = FUN_01030f98(1,&uStack_18);
    piVar2 = DAT_0102c2fc;
    if (iVar4 == 0) {
      *(undefined2 *)(iVar5 + 0x24) = uStack_18;
      *(undefined1 *)(iVar5 + 0x26) = uStack_16;
      *(undefined1 *)(iVar5 + 0x27) = uStack_15;
      *(undefined1 *)(iVar5 + 0x28) = uStack_13;
      *(undefined1 *)(iVar5 + 0x29) = uStack_12;
      *(undefined1 *)(iVar5 + 0x2a) = uStack_11;
    }
    else if (0 < *DAT_0102c2fc) {
      FUN_0104ba04(PTR_s___s__s__s___srtc_error__s_0102c314,PTR_s_general_0102c308,
                   PTR_s__ERR__0102c304,PTR_s_record_mgr_rtc_to_systime_0102c318,
                   PTR_s__010f8ede_0x1b_0102c300,PTR_s__010f8ede_0x1b_0102c300);
    }
    if (3 < *piVar2) {
      iVar4 = *piVar1;
      FUN_0104ba04(PTR_s___s__s__s___supdate_systime____0_0102c31c,PTR_s_general_0102c308,
                   PTR_s__DBG__0102c320,PTR_s_record_mgr_update_systime_0102c310,
                   PTR_s__010f8ede_0x1b_0102c300,*(undefined2 *)(iVar4 + 0x24),
                   *(undefined1 *)(iVar4 + 0x26),*(undefined1 *)(iVar4 + 0x27),
                   *(undefined1 *)(iVar4 + 0x28),*(undefined1 *)(iVar4 + 0x29),
                   *(undefined1 *)(iVar4 + 0x2a),*(undefined4 *)(iVar4 + 0x20),
                   PTR_s__010f8ede_0x1b_0102c300);
    }
    return 0;
  }
  return 0xffffffff;
}



/* FUN_0101109c @ 0101109c */

void FUN_0101109c(void)

{
  int *piVar1;
  int *piVar2;
  int iVar3;
  undefined4 uVar4;
  uint uVar5;
  
  piVar2 = DAT_01011140;
  piVar1 = DAT_01011134;
  if (*DAT_01011134 == 0) {
    FUN_0106c4e8(2,0x1c9,0x35b,DAT_01011138,0);
  }
  else {
    FUN_0106c4e8(3,0x1c9,0x35f,DAT_0101113c,0);
    FUN_01010788(0);
    if (*piVar2 != 0) {
      uVar4 = FUN_01090054();
      uVar5 = FUN_0105e1fc(uVar4,*piVar2);
      if (uVar5 < 0x65) {
        return;
      }
    }
    iVar3 = FUN_01090054();
    *piVar2 = iVar3;
    FUN_0106c4e8(3,0x1c9,0x367,DAT_01011144,0);
    iVar3 = *piVar1;
    *(undefined1 *)(iVar3 + 4) = 0;
    FUN_010812f4(0,iVar3 + 0x4e,10000);
    iVar3 = *piVar1;
    *(undefined1 *)(iVar3 + 0x4e) = 0xff;
    FUN_01081258(iVar3 + 0x48,0);
  }
  return;
}



/* FUN_0102e9c0 @ 0102e9c0 */

int FUN_0102e9c0(void)

{
  int *piVar1;
  int *piVar2;
  undefined4 uVar3;
  int iVar4;
  int iVar5;
  undefined1 uVar6;
  int iVar7;
  undefined1 *puVar8;
  
  piVar1 = DAT_0102eb48;
  if (((byte *)*DAT_0102eb48 != (byte *)0x0) && (*(byte *)*DAT_0102eb48 - 1 < 6)) {
    func_0x00000b68();
    stub();
    uVar3 = FUN_01090054(DAT_0102edc0);
    piVar2 = DAT_0102eb4c;
    iVar4 = func_0x0000050c(uVar3,1000);
    if (4 < (uint)(iVar4 - *piVar2)) {
      iVar4 = FUN_0102e1f0(*(undefined4 *)(*piVar1 + 8));
      if (iVar4 == 0) {
        uVar3 = FUN_01090054();
        iVar5 = func_0x0000050c(uVar3,1000);
        iVar7 = *piVar1;
        *piVar2 = iVar5;
        FUN_0102dc40(*(undefined4 *)(iVar7 + 8),*(undefined4 *)(iVar7 + 0xc));
        puVar8 = (undefined1 *)*piVar1;
        uVar6 = 6;
      }
      else {
        if (iVar4 == 1) {
          uVar3 = FUN_01090054();
          iVar4 = func_0x0000050c(uVar3,1000);
          *piVar2 = iVar4;
          return 1;
        }
        if (*DAT_0102ed30 < 5) {
          *DAT_0102ed30 = *DAT_0102ed30 + 1;
          return iVar4;
        }
        *DAT_0102ed30 = 0;
        puVar8 = (undefined1 *)*piVar1;
        uVar6 = 3;
      }
      *puVar8 = uVar6;
      return iVar4;
    }
  }
  return -1;
}



/* FUN_0101d590 @ 0101d590 */

void FUN_0101d590(void)

{
  FUN_01090054();
  return;
}



/* FUN_010217dc @ 010217dc */

void FUN_010217dc(void)

{
  int *piVar1;
  int *piVar2;
  uint uVar3;
  uint uVar4;
  uint *puVar5;
  int iVar6;
  
  piVar2 = DAT_01021844;
  piVar1 = DAT_01021840;
  iVar6 = 0;
  puVar5 = DAT_0102183c;
  do {
    if (*puVar5 != 0) {
      uVar3 = FUN_01090054();
      if (puVar5[2] <= uVar3) {
        if (((puVar5[3] & 1) != 0) && (3 < *piVar2)) {
          FUN_0104ba04(PTR_s___s__s__s___scallback_run_T_d____01021850,PTR_s_general_0102184c,
                       PTR_s__DBG__01021854,PTR_s_svz_async_loop_01021858,
                       PTR_s__010f8ede_0x1b_01021848,puVar5[2],PTR_s__010f8ede_0x1b_01021848);
        }
        uVar4 = *puVar5;
        uVar3 = puVar5[1];
        *piVar1 = iVar6;
        (*(code *)(uVar4 & 0xfffffffe))(uVar3);
        *puVar5 = 0;
        *piVar1 = -1;
      }
    }
    iVar6 = iVar6 + 1;
    puVar5 = puVar5 + 4;
  } while (iVar6 != 10);
  return;
}



/* FUN_01023390 @ 01023390 */

int FUN_01023390(void)

{
  char cVar1;
  int *piVar2;
  int *piVar3;
  undefined *puVar4;
  undefined4 uVar5;
  int iVar6;
  undefined *puVar7;
  int iVar8;
  int aiStack_1c [2];
  
  piVar2 = DAT_01023520;
  iVar6 = *DAT_01023520;
  if (iVar6 == 0) {
    return -1;
  }
  if (1 < (byte)(*(char *)(iVar6 + 0x30) - 3U)) goto LAB_0102343e;
  aiStack_1c[0] = 0;
  iVar6 = (*(code *)(*(uint *)(*(int *)(*(int *)(iVar6 + 0x44) + 4) + 8) & 0xfffffffe))
                    (*(int *)(iVar6 + 0x44),0,0x26,aiStack_1c);
  if (iVar6 == 0) {
LAB_010233e4:
    iVar6 = aiStack_1c[0];
    if (aiStack_1c[0] == -1) goto LAB_010233ee;
    iVar8 = *piVar2;
    cVar1 = *(char *)(iVar8 + 0x31);
    if (cVar1 == '\0') {
      if (aiStack_1c[0] == 1) {
        uVar5 = FUN_01090054();
        iVar6 = *piVar2;
        *(undefined4 *)(iVar8 + 0x34) = uVar5;
        *(undefined1 *)(iVar6 + 0x31) = 1;
        goto LAB_0102342e;
      }
LAB_01023ef8:
      iVar6 = *piVar2;
      goto LAB_01023438;
    }
    if (cVar1 != '\x01') {
      if (cVar1 != '\x02') goto LAB_01023ef8;
      if (aiStack_1c[0] != 0) goto LAB_0102343e;
      *(undefined1 *)(iVar8 + 0x31) = 0;
      goto LAB_0102342e;
    }
    iVar8 = FUN_01090054();
    if (((uint)(iVar8 - *(int *)(*piVar2 + 0x34)) < 0x1f) || (iVar6 != 1)) goto LAB_0102342e;
    *(undefined1 *)(*piVar2 + 0x31) = 2;
    if (2 < *DAT_01023524) {
      iVar6 = FUN_01090054();
      iVar6 = iVar6 - *(int *)(*piVar2 + 0x34);
      puVar4 = PTR_s___s__s__s___suac_boot_stale_use_t_01023550;
      puVar7 = PTR_s__INF__01023544;
      goto LAB_0102340a;
    }
  }
  else {
    aiStack_1c[0] = -1;
    if (0 < *DAT_01023524) {
      FUN_0104ba04(PTR_s___s__s__s___sUAC_get_boot_state_f_01023534,PTR_s_general_01023530,
                   PTR_s__ERR__0102352c,PTR_s_uac_dev_get_boot_state_01023538,
                   PTR_s__010f8ede_0x1b_01023528,iVar6,PTR_s__010f8ede_0x1b_01023528);
      goto LAB_010233e4;
    }
LAB_010233ee:
    if (0 < *DAT_01023524) {
      iVar6 = -1;
      puVar4 = PTR_s___s__s__s___suac_get_boot_state_f_01023540;
      puVar7 = PTR_s__ERR__0102352c;
LAB_0102340a:
      FUN_0104ba04(puVar4,PTR_s_general_01023530,puVar7,PTR_s_uac_dev_get_boot_stable_0102353c,
                   PTR_s__010f8ede_0x1b_01023528,iVar6,PTR_s__010f8ede_0x1b_01023528);
    }
LAB_0102342e:
    iVar6 = *piVar2;
    if (*(char *)(iVar6 + 0x31) != '\x02') {
LAB_01023438:
      *(undefined1 *)(iVar6 + 0x30) = 3;
    }
  }
LAB_0102343e:
  iVar6 = *piVar2;
  if (*(char *)(iVar6 + 0x2f) == '\0') {
    if (*(char *)(iVar6 + 0x2e) == '\x02') goto LAB_01023470;
    *(undefined1 *)(iVar6 + 0x2e) = 2;
    iVar6 = *DAT_01023524;
    puVar4 = PTR_s___s__s__s___s_detect__UAC_Normal_01023548;
  }
  else {
    if ((*(char *)(iVar6 + 0x2f) != '\x05') || (*(char *)(iVar6 + 0x2e) == '\x01'))
    goto LAB_01023470;
    *(undefined1 *)(iVar6 + 0x2e) = 1;
    iVar6 = *DAT_01023524;
    puVar4 = PTR_s___s__s__s___s_detect__UAC_Reject_01023554;
  }
  if (2 < iVar6) {
    FUN_0104ba04(puVar4,PTR_s_general_01023530,PTR_s__INF__01023544,PTR_s_uac_dev_dowork_0102354c,
                 PTR_s__010f8ede_0x1b_01023528,PTR_s__010f8ede_0x1b_01023528);
  }
LAB_01023470:
  cVar1 = *(char *)(*piVar2 + 0x30);
  if (cVar1 != '\0') {
    if ((cVar1 != '\x04') && (2 < *DAT_01023524)) {
      FUN_0104ba04(PTR_s___s__s__s___suac_work_state___d___01023558,PTR_s_general_01023530,
                   PTR_s__INF__01023544,PTR_s_uac_dev_dowork_0102354c,PTR_s__010f8ede_0x1b_01023528,
                   cVar1,PTR_s__010f8ede_0x1b_01023528);
    }
    if (*(byte *)(*piVar2 + 0x30) - 1 < 4) {
      func_0x00000b4c();
      piVar3 = DAT_010236fc;
      iVar6 = FUN_01022300(0);
      if (iVar6 == 0) {
        iVar6 = FUN_010221b4(0);
        if (iVar6 == 0) {
          FUN_0105dbec(PTR_s_sugr_app_01023718,0,0x6e,0,0);
          FUN_0105dbec(PTR_s_sugr_app_01023718,0,0x71,0,0);
          iVar6 = *piVar2;
          *(undefined1 *)(iVar6 + 7) = 0;
          *(undefined1 *)(iVar6 + 5) = 0;
          *(undefined1 *)(iVar6 + 0x31) = 0;
          *(undefined1 *)(iVar6 + 0x30) = 0;
          *(undefined1 *)(iVar6 + 0x2e) = 0;
          if (*piVar3 < 3) {
            return 0;
          }
          FUN_0104ba04(PTR_s___s__s__s___suac_power_off__s_01023720,PTR_s_general_01023708,
                       PTR_s__INF__0102371c,PTR_s_uac_dev_dowork_01023710,
                       PTR_s__010f8ede_0x1b_01023700,PTR_s__010f8ede_0x1b_01023700);
          return 0;
        }
        iVar8 = *piVar3;
        puVar4 = PTR_s___s__s__s___suac_power_off_faile_01023714;
      }
      else {
        iVar8 = *piVar3;
        puVar4 = PTR_s___s__s__s___suac_i2s_off_failed__0102370c;
      }
      if (0 < iVar8) {
        FUN_0104ba04(puVar4,PTR_s_general_01023708,PTR_s__ERR__01023704,
                     PTR_s_uac_dev_dowork_01023710,PTR_s__010f8ede_0x1b_01023700,iVar6,
                     PTR_s__010f8ede_0x1b_01023700);
        return iVar6;
      }
      return iVar6;
    }
  }
  return 0;
}



/* FUN_010248b8 @ 010248b8 */

undefined4 FUN_010248b8(void)

{
  int *piVar1;
  int *piVar2;
  undefined4 uVar3;
  undefined1 *puVar4;
  int iVar5;
  undefined4 uStack_14;
  
  piVar2 = DAT_01024930;
  piVar1 = DAT_0102492c;
  if (*DAT_0102492c == 0) {
    if (0 < *DAT_01024930) {
      FUN_0104ba04(PTR_s___s__s__s___spowermgr_no_init__s_01024940,PTR_s_general_0102493c,
                   PTR_s__ERR__01024938,PTR_s_power_mgr_config_01024944,
                   PTR_s__010f8ede_0x1b_01024934,PTR_s__010f8ede_0x1b_01024934);
    }
    uVar3 = 0xffffffff;
  }
  else {
    uStack_14 = 1;
    FUN_0102478c(0,&uStack_14);
    iVar5 = *piVar1;
    uVar3 = FUN_01090054();
    puVar4 = (undefined1 *)*piVar1;
    *(undefined4 *)(iVar5 + 0xc) = uVar3;
    *(undefined4 *)(puVar4 + 4) = 0xffffffff;
    *(undefined4 *)(puVar4 + 8) = 1;
    *puVar4 = 0;
    puVar4[0x10] = 2;
    if (2 < *piVar2) {
      FUN_0104ba04(PTR_s___s__s__s___spowermgr_config__s_0102494c,PTR_s_general_0102493c,
                   PTR_s__INF__01024948,PTR_s_power_mgr_config_01024944,
                   PTR_s__010f8ede_0x1b_01024934,PTR_s__010f8ede_0x1b_01024934);
    }
    uVar3 = 0;
  }
  return uVar3;
}



/* FUN_010280e8 @ 010280e8 */

undefined4 FUN_010280e8(void)

{
  int *piVar1;
  uint *puVar2;
  uint uVar3;
  int iVar4;
  char cVar5;
  uint uVar6;
  int iVar7;
  undefined1 uStack_d;
  
  piVar1 = DAT_01028264;
  if ((char *)*DAT_01028264 == (char *)0x0) {
    return 0xffffffff;
  }
  cVar5 = *(char *)*DAT_01028264;
  if (cVar5 == '\0') {
    return 0;
  }
  if (((cVar5 != '\x04') && (cVar5 != '\x01')) && (2 < *DAT_01028268)) {
    FUN_0104ba04(PTR_s___s__s__s___spot_work_state___d___01028274,PTR_s_general_01028270,
                 PTR_s__INF__0102827c,PTR_s_pot_dev_dowork_01028278,PTR_s__010f8ede_0x1b_0102826c,
                 cVar5,PTR_s__010f8ede_0x1b_0102826c);
  }
  puVar2 = DAT_01028280;
  cVar5 = *(char *)*piVar1;
  if (cVar5 == '\x03') {
    cVar5 = '\x04';
LAB_01028134:
    *(char *)*piVar1 = cVar5;
    return 0;
  }
  if (cVar5 != '\x04') {
    if (cVar5 != '\x02') {
      return 0;
    }
    cVar5 = '\x03';
    goto LAB_01028134;
  }
  uVar3 = FUN_01090054();
  if (uVar3 < *puVar2) {
    return 0;
  }
  iVar4 = FUN_01090054();
  iVar7 = *piVar1;
  *puVar2 = iVar4 + 0x32;
  iVar4 = (*(code *)(*(uint *)(*(int *)(*(int *)(iVar7 + 0xc) + 4) + 8) & 0xfffffffe))
                    (*(int *)(iVar7 + 0xc),DAT_01028284);
  if (iVar4 == 0) {
    uVar3 = (uint)*DAT_01028294;
  }
  else {
    if (0 < *DAT_01028268) {
      FUN_0104ba04(PTR_s___s__s__s___s_s__d__get_pot_adc_f_01028290,PTR_s_general_01028270,
                   PTR_s__ERR__0102828c,PTR_s_pot_dev_get_pot_adc_01028288,
                   PTR_s__010f8ede_0x1b_0102826c,PTR_s_pot_dev_get_pot_adc_01028288,0x5b,iVar4,
                   PTR_s__010f8ede_0x1b_0102826c);
    }
    uVar3 = 0xffffffff;
  }
  uVar3 = uVar3 * 0xe10;
  if ((uVar3 & 0x80000000) != 0) {
    uVar3 = uVar3 + 0x3ff;
  }
  uVar3 = (int)uVar3 >> 10;
  if ((uVar3 & 0x80000000) != 0) {
    *(undefined4 *)(*piVar1 + 4) = 0xffffffff;
    if (*DAT_01028268 < 1) {
      return 0;
    }
    FUN_0104ba04(PTR_s___s__s__s___sadc_get_pot_failed___01028298,PTR_s_general_01028270,
                 PTR_s__ERR__0102828c,PTR_s_pot_dev_state_msg_event_0102829c,
                 PTR_s__010f8ede_0x1b_0102826c,PTR_s__010f8ede_0x1b_0102826c);
    return 0;
  }
  iVar4 = *piVar1;
  uVar6 = *(int *)(iVar4 + 4) - uVar3;
  if ((uVar6 & 0x80000000) != 0) {
    uVar6 = -uVar6;
  }
  if ((int)uVar6 < 0x65) {
    return 0;
  }
  *(uint *)(iVar4 + 4) = uVar3;
  if ((int)uVar3 < 0x1f5) {
    iVar7 = 0;
  }
  else if ((int)uVar3 < 0x44d) {
    iVar7 = 1;
  }
  else if ((int)uVar3 < 0x5dd) {
    iVar7 = 2;
  }
  else {
    iVar7 = 3;
    if (0x640 < (int)uVar3) goto LAB_0102820c;
  }
  iVar7 = (int)(char)PTR_DAT_010282a0[iVar7 * 8];
LAB_0102820c:
  uStack_d = (undefined1)iVar7;
  if (*(char *)(iVar4 + 8) == iVar7) {
    return 0;
  }
  *(undefined1 *)(iVar4 + 8) = uStack_d;
  FUN_0105dbec(PTR_s_sugr_app_010282a4,0,0x80,&uStack_d,1);
  if (*DAT_01028268 < 3) {
    return 0;
  }
  FUN_0104ba04(PTR_s___s__s__s___spot_vol___dmV__s_010282a8,PTR_s_general_01028270,
               PTR_s__INF__0102827c,PTR_s_pot_dev_state_msg_event_0102829c,
               PTR_s__010f8ede_0x1b_0102826c,*(undefined4 *)(*piVar1 + 4),
               PTR_s__010f8ede_0x1b_0102826c);
  return 0;
}



/* FUN_0102fa48 @ 0102fa48 */

undefined4 FUN_0102fa48(void)

{
  int *piVar1;
  int *piVar2;
  int iVar3;
  undefined4 uVar4;
  char cVar5;
  byte *pbVar6;
  int iVar7;
  byte *pbVar8;
  uint uVar9;
  int iVar10;
  undefined4 uVar11;
  
  piVar1 = DAT_0102fbcc;
  if ((char *)*DAT_0102fbcc == (char *)0x0) {
    return 0xffffffff;
  }
  cVar5 = *(char *)*DAT_0102fbcc;
  if (cVar5 == '\0') {
    return 0;
  }
  if (((cVar5 != '\x04') && (cVar5 != '\x02')) && (2 < *DAT_0102fbd0)) {
    FUN_0104ba04(PTR_s___s__s__s___ssim_uart_work_state_0102fbdc,PTR_s_general_0102fbd8,
                 PTR_s__INF__0102fbe4,PTR_s_sim_uart_dev_dowork_0102fbe0,
                 PTR_s__010f8ede_0x1b_0102fbd4,cVar5,PTR_s__010f8ede_0x1b_0102fbd4);
  }
  pbVar8 = DAT_0102fbe8;
  pbVar6 = (byte *)*piVar1;
  if (*pbVar6 == 3) {
LAB_0102fafe:
    *pbVar6 = 4;
    return 0;
  }
  if (*pbVar6 != 4) {
    return 0;
  }
  iVar10 = (uint)*DAT_0102fbe8 + DAT_0102fbec;
  if ((*(int *)(pbVar6 + 0x18) != 0) &&
     (iVar3 = func_0x00080420(), piVar2 = DAT_0102fbd0, 0 < iVar3)) {
    iVar10 = FUN_010729f8(*(undefined4 *)(*piVar1 + 0x18),iVar10,1);
    iVar7 = *piVar2;
    if (iVar10 < 1) {
      if (0 < iVar7) {
        FUN_0104ba04(PTR_s___s__s__s___scan_t_read_from_str_0102fc00,PTR_s_general_0102fbd8,
                     PTR_s__ERR__0102fbfc,PTR_s_sim_uart_dev_read_bytes_0102fbf4,
                     PTR_s__010f8ede_0x1b_0102fbd4,PTR_s__010f8ede_0x1b_0102fbd4);
      }
    }
    else {
      if (3 < iVar7) {
        FUN_0104ba04(PTR_s___s__s__s___sread__d_data_from_s_0102fbf8,PTR_s_general_0102fbd8,
                     PTR_s__DBG__0102fbf0,PTR_s_sim_uart_dev_read_bytes_0102fbf4,
                     PTR_s__010f8ede_0x1b_0102fbd4,iVar10,iVar3,PTR_s__010f8ede_0x1b_0102fbd4);
      }
      if (iVar10 == 1) {
        if (*pbVar8 < 4) {
          func_0x00000b4c();
          pbVar6 = pbVar8;
          goto LAB_0102fafe;
        }
        if (0 < *piVar2) {
          FUN_0104ba04(PTR_s___s__s__s___serror_case_s_0102fdac,PTR_s_general_0102fd78,
                       PTR_s__ERR__0102fd84,PTR_s_sim_uart_dev_state_analyze_data_0102fd80,
                       PTR_s__010f8ede_0x1b_0102fd74,PTR_s__010f8ede_0x1b_0102fd74);
        }
        *pbVar8 = 0;
        uVar11 = 1;
        goto LAB_0102fb34;
      }
    }
  }
  uVar11 = 0xffffffff;
LAB_0102fb34:
  iVar3 = *(int *)(*piVar1 + 0x28);
  iVar10 = FUN_01090054();
  uVar9 = iVar10 - iVar3;
  iVar7 = *piVar1;
  if (uVar9 < 3000) {
    if ((((uint)(iVar3 - *(int *)(iVar7 + 0x30)) < 0x2711) && (299 < uVar9)) &&
       (*(byte *)(iVar7 + 0x2c) < 3)) {
      uVar4 = FUN_01090054();
      iVar3 = *piVar1;
      *(undefined4 *)(iVar7 + 0x28) = uVar4;
      cVar5 = *(char *)(iVar3 + 0x2c) + '\x01';
      *(char *)(iVar3 + 0x2c) = cVar5;
      if (2 < *DAT_010301e8) {
        FUN_0104ba04(PTR_s___s__s__s___sheadset_read_data_t_010301f4,PTR_s_general_010301f0,
                     PTR_s__INF__010301fc,PTR_s_sim_uart_dev_timeout_monitor_010301f8,
                     PTR_s__010f8ede_0x1b_010301ec,cVar5,PTR_s__010f8ede_0x1b_010301ec);
      }
    }
  }
  else if (*(char *)(iVar7 + 0x22) != '\0') {
    if (2 < *DAT_0102fbd0) {
      FUN_0104ba04(PTR_s___s__s__s___sheadset_data_timeou_0102fc04,PTR_s_general_0102fbd8,
                   PTR_s__INF__0102fbe4,PTR_s_sim_uart_dev_timeout_monitor_0102fc08,
                   PTR_s__010f8ede_0x1b_0102fbd4,PTR_s__010f8ede_0x1b_0102fbd4);
    }
    if (2 < *(byte *)(*piVar1 + 0x22)) {
      FUN_0105dbec(PTR_s_sugr_app_0102fc0c,0,0x8e,0,0);
    }
    *(undefined1 *)(*piVar1 + 0x22) = 0;
  }
  iVar3 = *piVar1;
  if (*(char *)(iVar3 + 0x35) == '\0') {
    return uVar11;
  }
  if ((uint)(iVar10 - *(int *)(iVar3 + 0x30)) < 5000) {
    return uVar11;
  }
  *(undefined1 *)(iVar3 + 0x35) = 0;
  if (2 < *DAT_0102fbd0) {
    FUN_0104ba04(PTR_s___s__s__s___sheadset_version_tim_0102fc10,PTR_s_general_0102fbd8,
                 PTR_s__INF__0102fbe4,PTR_s_sim_uart_dev_timeout_monitor_0102fc08,
                 PTR_s__010f8ede_0x1b_0102fbd4,PTR_s__010f8ede_0x1b_0102fbd4);
    return uVar11;
  }
  return uVar11;
}



/* FUN_01030e3c @ 01030e3c */

undefined4 FUN_01030e3c(void)

{
  int *piVar1;
  uint *puVar2;
  uint uVar3;
  int iVar4;
  char cVar5;
  char *pcVar6;
  
  piVar1 = DAT_01030edc;
  if ((char *)*DAT_01030edc == (char *)0x0) {
    return 0xffffffff;
  }
  cVar5 = *(char *)*DAT_01030edc;
  if (cVar5 == '\0') {
    return 0;
  }
  if (((cVar5 != '\x04') && (cVar5 != '\x01')) && (2 < *DAT_01030ee0)) {
    FUN_0104ba04(PTR_s___s__s__s___srtc_work_state___d__01030eec,PTR_s_general_01030ee8,
                 PTR_s__INF__01030ef4,PTR_s_rtc_dev_dowork_01030ef0,PTR_s__010f8ede_0x1b_01030ee4,
                 cVar5,PTR_s__010f8ede_0x1b_01030ee4);
  }
  puVar2 = DAT_01030ef8;
  pcVar6 = (char *)*piVar1;
  cVar5 = *pcVar6;
  if (cVar5 == '\x03') {
    cVar5 = '\x04';
  }
  else {
    if (cVar5 == '\x04') {
      if (pcVar6 == (char *)0x0) {
        return 0;
      }
      uVar3 = FUN_01090054();
      if (uVar3 < *puVar2) {
        return 0;
      }
      iVar4 = FUN_01090054();
      *puVar2 = iVar4 + 30000;
      iVar4 = FUN_010304c8(*piVar1 + 2);
      if (iVar4 == 0) {
        return 0;
      }
      if (*DAT_01030ee0 < 1) {
        return 0;
      }
      FUN_0104ba04(PTR_s___s__s__s___sget_time_fail__s_01030f00,PTR_s_general_01030ee8,
                   PTR_s__ERR__01030efc,PTR_s_rtc_dev_check_status_01030f04,
                   PTR_s__010f8ede_0x1b_01030ee4,PTR_s__010f8ede_0x1b_01030ee4);
      return 0;
    }
    if (cVar5 != '\x02') {
      return 0;
    }
    cVar5 = '\x03';
  }
  *pcVar6 = cVar5;
  return 0;
}



/* FUN_0103257c @ 0103257c */

undefined4 FUN_0103257c(short *param_1,undefined1 *param_2,int param_3)

{
  short sVar1;
  short sVar2;
  int *piVar3;
  short *psVar4;
  undefined1 *puVar5;
  undefined4 uVar6;
  undefined *puVar7;
  short *psVar8;
  uint uVar9;
  int iVar10;
  undefined *puVar11;
  undefined1 *puVar12;
  int iVar13;
  
  psVar8 = DAT_010326a0;
  piVar3 = DAT_0103269c;
  if ((((param_1 == (short *)0x0) || (iVar13 = *DAT_0103269c, iVar13 == 0)) ||
      (*(int *)(iVar13 + 4) == 0)) ||
     ((param_2 == (undefined1 *)0x0 || (*(char *)(iVar13 + 1) != '\x01')))) {
    return 0xffffffff;
  }
  psVar4 = param_1;
  puVar12 = param_2;
  if (param_3 == 2) {
    if (*(char *)(iVar13 + 0x30) == '\x01') {
      uVar9 = 0;
      while (((undefined1 *)(uVar9 * 2 + 3) < param_2 && (uVar9 + 2 != 0xc2))) {
        sVar1 = *param_1;
        sVar2 = param_1[1];
        *(undefined1 *)((int)psVar8 + uVar9) = (char)((int)sVar1 + (int)sVar2);
        ((undefined1 *)((int)psVar8 + uVar9))[1] = (char)((uint)((int)sVar1 + (int)sVar2) >> 8);
        param_1 = param_1 + 2;
        uVar9 = uVar9 + 2;
      }
      puVar12 = (undefined1 *)(uVar9 & 0xffff);
      psVar4 = DAT_010326a0;
    }
  }
  else if ((param_3 == 1) && (*(char *)(iVar13 + 0x30) == '\x02')) {
    iVar10 = 1 - (int)param_1;
    for (puVar12 = (undefined1 *)0x0;
        (psVar4 = DAT_010326a0, (undefined1 *)(iVar10 + (int)param_1) < param_2 &&
        (puVar12 != (undefined1 *)0xc0)); puVar12 = (undefined1 *)((uint)(puVar12 + 4) & 0xffff)) {
      *(char *)psVar8 = (char)*param_1;
      *(undefined1 *)((int)psVar8 + 1) = *(undefined1 *)((int)param_1 + 1);
      *(char *)(psVar8 + 1) = (char)*param_1;
      puVar5 = (undefined1 *)((int)param_1 + 1);
      param_1 = param_1 + 1;
      *(undefined1 *)((int)psVar8 + 3) = *puVar5;
      psVar8 = psVar8 + 2;
    }
  }
  puVar5 = (undefined1 *)FUN_01072b2c(*(undefined4 *)(iVar13 + 4),psVar4,puVar12);
  if (puVar12 == puVar5) {
    *(undefined1 *)(*piVar3 + 0x31) = 0;
    puVar7 = PTR_s___s__s__s___sstream_write_num____010326c0;
    puVar11 = PTR_s__DBG__010326bc;
    if (*DAT_010326a4 < 4) {
      return 0;
    }
  }
  else {
    iVar13 = *piVar3;
    if (*(char *)(iVar13 + 0x31) != '\0') {
      return 0;
    }
    *(undefined1 *)(iVar13 + 0x31) = 1;
    uVar6 = FUN_01090054();
    piVar3 = DAT_010326a4;
    *(undefined4 *)(iVar13 + 0x34) = uVar6;
    puVar7 = PTR_s___s__s__s___sstream_write_error_n_010326b4;
    puVar11 = PTR_s__ERR__010326ac;
    if (*piVar3 < 1) {
      return 0;
    }
  }
  FUN_0104ba04(puVar7,PTR_s_general_010326b0,puVar11,PTR_s_live_mgr_write_stream_010326b8,
               PTR_s__010f8ede_0x1b_010326a8,puVar12,PTR_s__010f8ede_0x1b_010326a8);
  return 0;
}



/* FUN_01038e10 @ 01038e10 */

/* WARNING: Type propagation algorithm not settling */

uint FUN_01038e10(int param_1,char *param_2,int param_3)

{
  bool bVar1;
  undefined1 uVar2;
  undefined3 uVar3;
  undefined *puVar4;
  int *piVar5;
  int *piVar6;
  undefined1 uVar7;
  char cVar8;
  undefined2 uVar9;
  undefined4 uVar10;
  int iVar11;
  undefined1 *puVar12;
  int iVar13;
  uint uVar14;
  undefined *puVar15;
  uint uVar16;
  undefined *puVar17;
  undefined *puVar18;
  undefined *puVar19;
  undefined1 uVar20;
  int3 iVar21;
  undefined1 uVar25;
  int iVar22;
  uint uVar23;
  int iVar24;
  int *piVar26;
  undefined1 *puVar27;
  char *pcVar28;
  uint uVar29;
  uint uStack_bc;
  int iStack_b8;
  uint uStack_b0;
  uint uStack_a8;
  uint uStack_a4;
  uint uStack_a0;
  uint uStack_9c;
  int iStack_98;
  int iStack_94;
  int iStack_90;
  int iStack_8c;
  int iStack_88;
  int iStack_84;
  uint uStack_80;
  int iStack_7c;
  int *piStack_78;
  int iStack_68;
  char cStack_55;
  uint uStack_54;
  uint uStack_50;
  uint uStack_4c;
  uint uStack_48;
  undefined4 uStack_44;
  undefined1 uStack_3f;
  undefined1 uStack_3e;
  undefined1 uStack_3d;
  undefined1 auStack_38 [36];
  
  uStack_54 = 0;
  func_0x0008009e(auStack_38,0,0x21);
  cStack_55 = *param_2;
  iStack_7c = FUN_01090054();
  piVar5 = DAT_01038ff4;
  if ((param_1 == 0) || (param_2 == (char *)0x0)) {
    if (*DAT_01038fdc < 1) {
      return 0xffffffff;
    }
    FUN_0104ba04(PTR_s___s__s__s___shead_or_data_buf_is_01038fec,PTR_s_usbiap2_01038fe8,
                 PTR_s__ERR__01038fe4,PTR_s_usbiap2_hinotes_protocol_structu_01038ff0,
                 PTR_s__010f8ede_0x1b_01038fe0,PTR_s__010f8ede_0x1b_01038fe0);
    return 0xffffffff;
  }
  iVar22 = *DAT_01038ff4;
  uStack_bc = (*(ushort *)(param_1 + 2) & 0xff) << 8 | (uint)(*(ushort *)(param_1 + 2) >> 8);
  uVar3 = *(undefined3 *)(param_1 + 4);
  uVar2 = *(undefined1 *)(param_1 + 7);
  uVar10 = FUN_01073168();
  iVar11 = func_0x000800b6(uVar10,PTR_DAT_01038ff8,4);
  if (iVar11 == 0) {
    if (uStack_bc != 1) {
      uStack_bc = 0xffff;
    }
    iStack_8c = 0;
    iStack_90 = 0;
    uStack_a0 = 0;
    uStack_b0 = 0xffffffff;
    uStack_9c = 0;
    uStack_80 = uStack_a0;
LAB_01039046:
    iVar11 = FUN_0104f730();
    if (iVar11 == 1) {
      iStack_b8 = *(int *)(iVar22 + 4);
      uVar23 = param_3 - 0x24;
LAB_01039058:
      puVar4 = PTR_s__010f8ede_0x1b_010391a4;
      piVar6 = DAT_010391a0;
      uVar20 = (undefined1)((uint3)uVar3 >> 0x10);
LAB_0103907a:
      pcVar28 = DAT_010391c0;
      puVar17 = PTR_s___s__s__s___sout_buf_error__s_0103961c;
      puVar19 = PTR_s__ERR__01039624;
      puVar18 = PTR_s_usbiap2_01039628;
      if (uStack_bc < 0x1a) {
        if ((0x15 < uStack_bc) || (uStack_bc == 10)) goto LAB_01039256;
        if (10 < uStack_bc) {
          if (uStack_bc == 0x11) goto LAB_01039256;
          if (uStack_bc < 0x12) {
            if (uStack_bc == 0xc) goto LAB_01039256;
            if (uStack_bc < 0xc) {
              uStack_44 = 0;
              if ((iStack_b8 + 0xc != 0) && (uVar23 != 0)) {
                iVar11 = *piVar5;
                FUN_0102d828(0xf,&uStack_44);
                if (uStack_44 == 0) {
                  uStack_44 = 2;
                }
                uVar7 = (undefined1)(uStack_44 >> 8);
                uStack_44 = CONCAT31(CONCAT21(CONCAT11((char)uStack_44,uVar7),uVar7),(char)uStack_44
                                    );
                func_0x000800aa(iStack_b8 + 0xc,&uStack_44,4);
                uStack_54 = 4;
                uStack_44 = 0;
                FUN_0102d828(0x10,&uStack_44);
                if (uStack_44 == 0) {
                  uStack_44 = 2;
                }
                uVar7 = (undefined1)(uStack_44 >> 8);
                uStack_44 = CONCAT31(CONCAT21(CONCAT11((char)uStack_44,uVar7),uVar7),(char)uStack_44
                                    );
                func_0x000800aa(iStack_b8 + 0x10,&uStack_44,4);
                uStack_54 = uStack_54 + 4;
                if (iVar11 != 0) {
                  iVar21 = (byte)~(*(char *)(iVar11 + 9) != '\0') + 1;
                  uVar7 = (undefined1)iVar21;
                  uVar25 = (undefined1)((uint3)iVar21 >> 8);
                  uStack_44 = CONCAT31(CONCAT21(CONCAT11(uVar7,uVar25),uVar25),uVar7);
                  func_0x000800aa(iStack_b8 + 0x14,&uStack_44,4);
                  uStack_54 = uStack_54 + 4;
                }
                uStack_44 = 0;
                uVar14 = FUN_0102d828(0x15,&uStack_44);
                if (uStack_44 == 0) {
                  uStack_44 = 2;
                }
                uVar7 = (undefined1)(uStack_44 >> 8);
                uStack_44 = CONCAT31(CONCAT21(CONCAT11((char)uStack_44,uVar7),uVar7),(char)uStack_44
                                    );
                iVar11 = iStack_b8 + 0x18;
                goto LAB_01039eec;
              }
              iVar11 = *piVar6;
              puVar15 = PTR_s_usbiap2_get_device_config_01039ff8;
            }
            else {
              if (uStack_bc == 0xd) goto LAB_01039bfc;
              if (uStack_bc != 0x10) goto LAB_010390a6;
              uStack_50 = 0;
              uStack_4c = 0;
              uStack_48 = 0;
              if ((iStack_b8 + 0xc != 0) && (uVar23 != 0)) {
                uVar9 = FUN_0105a8fc();
                uVar7 = (undefined1)((ushort)uVar9 >> 8);
                uStack_50 = CONCAT31(CONCAT21(CONCAT11((char)uVar9,uVar7),uVar7),(char)uVar9);
                func_0x000800aa(iStack_b8 + 0xc,&uStack_50,4);
                uVar9 = FUN_0105a954();
                uVar7 = (undefined1)((ushort)uVar9 >> 8);
                uStack_50 = CONCAT31(CONCAT21(CONCAT11((char)uVar9,uVar7),uVar7),(char)uVar9);
                func_0x000800aa(iStack_b8 + 0x10,&uStack_50,4);
                iVar11 = FUN_0105af44(&uStack_4c);
                uVar10 = 0;
                if (iVar11 != 0) {
                  uStack_4c = 0;
                  uVar10 = 0xffffffff;
                }
                uVar7 = (undefined1)(uStack_4c >> 8);
                uStack_4c = CONCAT31(CONCAT21(CONCAT11((char)uStack_4c,uVar7),uVar7),(char)uStack_4c
                                    );
                func_0x000800aa(iStack_b8 + 0x14,&uStack_4c,4);
                FUN_0105ae9c(&uStack_48);
                uVar7 = (undefined1)(uStack_48 >> 8);
                uStack_48 = CONCAT31(CONCAT21(CONCAT11((char)uStack_48,uVar7),uVar7),(char)uStack_48
                                    );
                if (2 < *piVar6) {
                  FUN_0104ba04(PTR_s___s__s__s___sres__d__card_status_01039ffc,
                               PTR_s_usbiap2_0103a008,PTR_s__INF__0103a004,
                               PTR_s_usbiap2_get_sdcard_info_0103a000,puVar4,uVar10,uStack_4c,
                               uStack_48,puVar4);
                }
                func_0x000800aa(iStack_b8 + 0x18,&uStack_48,4);
                FUN_0105aeec(&uStack_44);
                func_0x000800aa(iStack_b8 + 0x1c,&uStack_44,0xc);
                uStack_54 = uStack_54 + 0x1c;
                goto LAB_010394e2;
              }
              iVar11 = *piVar6;
              puVar15 = PTR_s_usbiap2_get_sdcard_info_01039428;
            }
          }
          else {
            if (0x14 < uStack_bc) {
LAB_01039bfc:
              if (uStack_b0 != 0) goto LAB_010394e2;
              if ((iStack_b8 + 0xc == 0) || (uVar23 == 0)) {
                iVar11 = *piVar6;
                puVar15 = PTR_s_usbiap2_get_file_record_data_sec_01039dac;
                goto joined_r0x01039b24;
              }
              if (2 < *piVar6) {
                FUN_0104ba04(PTR_s___s__s__s___stotal_data_remain___01039db0,PTR_s_usbiap2_01039db8,
                             PTR_s__INF__01039db4,PTR_s_usbiap2_get_file_record_data_sec_01039dac,
                             puVar4,uStack_9c,uStack_a0,puVar4);
              }
              iVar11 = FUN_01066a00(iStack_90,uStack_a0,0);
              if (iVar11 == 0) {
                uVar29 = uVar23;
                if (uStack_9c < uVar23) {
                  uVar29 = uStack_9c;
                }
                uVar16 = FUN_010669a8(iStack_90,iStack_b8 + 0xc,uVar29);
                uVar14 = uVar16;
                if ((int)uVar16 < 1) {
                  uStack_54 = 0;
                  puVar17 = PTR_s___s__s__s___sread_error_file__re_01039dc4;
                  puVar19 = PTR_s__ERR__01039dbc;
                  if (0 < *piVar6) {
LAB_01039caa:
                    FUN_0104ba04(puVar17,PTR_s_usbiap2_01039db8,puVar19,
                                 PTR_s_usbiap2_get_file_record_data_sec_01039dac,puVar4,uVar16,
                                 puVar4);
                  }
                  goto LAB_01039cae;
                }
                uStack_9c = uStack_9c - uVar16;
                uStack_54 = uVar16;
                if (uVar16 == uVar29) {
                  puVar17 = PTR_s___s__s__s___sread_data_len__d__s_01039dc8;
                  puVar19 = PTR_s__INF__01039db4;
                  if (2 < *piVar6) goto LAB_01039caa;
                }
                else {
                  if (2 < *piVar6) {
                    uVar14 = 0;
                    FUN_0104ba04(PTR_s___s__s__s___sread_data_len__d__r_01039dcc,
                                 PTR_s_usbiap2_01039db8,PTR_s__INF__01039db4,
                                 PTR_s_usbiap2_get_file_record_data_sec_01039dac,puVar4,uVar16,
                                 puVar4);
                    goto LAB_01039cae;
                  }
                  uVar14 = 0;
                }
                if (uStack_9c != 0) goto LAB_010395a2;
              }
              else {
                uStack_54 = 0;
                if (0 < *piVar6) {
                  FUN_0104ba04(PTR_s___s__s__s___sError_seek_file__of_01039dc0,
                               PTR_s_usbiap2_01039db8,PTR_s__ERR__01039dbc,
                               PTR_s_usbiap2_get_file_record_data_sec_01039dac,puVar4,uStack_a0,
                               puVar4);
                }
                uVar14 = 0xffffffff;
LAB_01039cae:
                if (uStack_9c != 0) goto LAB_010395a2;
                puVar15 = PTR_s___s__s__s___sread_data_len__d__r_01039bf8;
                puVar17 = PTR_s_usbiap2_01039bd8;
                puVar18 = PTR_s__INF__01039bd4;
                puVar19 = PTR_s_usbiap2_get_file_record_data_sec_01039dac;
                if (2 < *piVar6) goto LAB_01039b5c;
              }
              uStack_9c = 0;
              goto LAB_010394e2;
            }
            if (0x12 < uStack_bc) goto LAB_01039256;
            uStack_44 = (uint)uStack_44._1_3_ << 8;
            if ((iStack_b8 + 0xc != 0) && (uVar23 != 0)) {
              FUN_0102d828(10,&uStack_44);
              if (((uStack_44 & 0xff) == 0) || (iVar11 = FUN_0105a24c(0x21), iVar11 == 0)) {
                uStack_54 = 0;
              }
              else {
                FUN_0102d828(0x12,iVar11);
                uVar14 = func_0x000800d2(iVar11);
                if (uVar14 < 5) {
                  uVar14 = 0;
                }
                else {
                  iVar24 = func_0x000800d2(iVar11);
                  uVar14 = iVar24 - 4U & 0xff;
                  if (uVar14 != 0) {
                    func_0x000800aa(iStack_b8 + 0xc,iVar11 + 4,uVar14);
                  }
                }
                FUN_0105a260(iVar11);
                uStack_54 = uVar14;
              }
              goto LAB_010394e2;
            }
            iVar11 = *piVar6;
            puVar15 = PTR_s_usbiap2_get_recording_file_0103942c;
          }
          goto joined_r0x01039b24;
        }
        if (uStack_bc == 5) {
LAB_01039b08:
          if (uStack_b0 != 0) goto LAB_010394e2;
          if ((iStack_b8 + 0xc == 0) || (uVar23 == 0)) {
            iVar11 = *piVar6;
            puVar15 = PTR_s_usbiap2_get_file_record_data_01039be4;
            goto joined_r0x01039b24;
          }
          iVar11 = FUN_01066a00(iStack_90,uStack_a0,0);
          if (iVar11 == 0) {
            uVar14 = FUN_010669a8(iStack_90,iStack_b8 + 0xc,uVar23);
            puVar17 = PTR_s_usbiap2_01039bd8;
            puVar19 = PTR_s_usbiap2_get_file_record_data_01039be4;
            if (0 < (int)uVar14) {
              uStack_54 = uVar14;
              if (uVar23 == uVar14) {
                if (2 < *piVar6) {
                  FUN_0104ba04(PTR_s___s__s__s___sread_data_len__d__o_01039bf4,
                               PTR_s_usbiap2_01039bd8,PTR_s__INF__01039bd4,
                               PTR_s_usbiap2_get_file_record_data_01039be4,puVar4,uVar23,uStack_a0,
                               puVar4);
                }
                bVar1 = false;
                goto LAB_01039756;
              }
              puVar15 = PTR_s___s__s__s___sread_data_len__d__r_01039bf8;
              puVar18 = PTR_s__INF__01039bd4;
              if (*piVar6 < 3) goto LAB_010394e2;
              goto LAB_01039b5c;
            }
            uStack_54 = 0;
            iVar11 = *piVar6;
            puVar18 = PTR_s__ERR__01039be8;
            puVar15 = PTR_s___s__s__s___sread_error_file__re_01039bf0;
          }
          else {
            uStack_54 = 0;
            iVar11 = *piVar6;
            puVar17 = PTR_s_usbiap2_01039bd8;
            puVar19 = PTR_s_usbiap2_get_file_record_data_01039be4;
            puVar18 = PTR_s__ERR__01039be8;
            puVar15 = PTR_s___s__s__s___sError_seek_file__of_01039bec;
            uVar14 = uStack_a0;
          }
joined_r0x01039b48:
          if (iVar11 < 1) goto LAB_010394e2;
LAB_01039b5c:
          FUN_0104ba04(puVar15,puVar17,puVar18,puVar19,puVar4,uVar14,puVar4);
          goto LAB_010394e2;
        }
        if (5 < uStack_bc) {
          if (uStack_bc < 9) {
            if (uStack_bc < 7) {
              if ((iStack_b8 + 0xc == 0) || (uVar23 == 0)) {
                iVar11 = *piVar6;
                puVar15 = PTR_s_usbiap2_get_files_num_01039dd0;
                goto joined_r0x01039b24;
              }
              uStack_4c = (uint)uStack_4c._1_3_ << 8;
              FUN_0102f3fc(0,&uStack_4c);
              if ((uStack_4c & 0xff) < 4) {
                uVar14 = FUN_0105aa84(PTR_DAT_01039de4,PTR_DAT_01039de0,PTR_DAT_01039ddc,&uStack_44)
                ;
                if (uVar14 == 0) {
                  uStack_48 = uStack_48 & 0xffffff00;
                  FUN_0102d828(10,&uStack_48);
                  if (((char)uStack_48 != '\0') && (uStack_44 != 0)) {
                    uStack_44 = uStack_44 - 1;
                  }
                  goto LAB_01039d52;
                }
                if (0 < *piVar6) {
                  FUN_0104ba04(PTR_s___s__s__s___sget_file_num_error___01039de8,
                               PTR_s_usbiap2_01039db8,PTR_s__ERR__01039dbc,
                               PTR_s_usbiap2_get_files_num_01039dd0,puVar4,uVar14,puVar4);
                }
                if (uVar14 != 0xffffffea) goto LAB_010395a2;
                uStack_44 = 0;
              }
              else {
                uVar14 = FUN_0102f3fc(4,&uStack_44);
LAB_01039d52:
                if (1 < *piVar6) {
                  FUN_0104ba04(PTR_s___s__s__s___sget_file_num__d__s_01039dd8,PTR_s_usbiap2_01039db8
                               ,PTR_s__WRN__01039dd4,PTR_s_usbiap2_get_files_num_01039dd0,puVar4,
                               uStack_44,puVar4);
                }
                uVar7 = (undefined1)(uStack_44 >> 8);
                uStack_44 = CONCAT31(CONCAT21(CONCAT11((char)uStack_44,uVar7),uVar7),(char)uStack_44
                                    );
              }
              func_0x000800aa(iStack_b8 + 0xc,&uStack_44,4);
              uStack_54 = 4;
              goto LAB_010395a2;
            }
          }
          else if (cStack_55 != '\0') {
            FUN_01037c58(0);
          }
          goto LAB_01039256;
        }
        if (uStack_bc == 2) {
          if ((iStack_b8 != -0xc) && (uVar23 != 0)) {
            uVar14 = FUN_01030f98(1,&uStack_44);
            if (uVar14 == 0) {
              *(undefined1 *)(iStack_b8 + 0xc) = 0x20;
              uVar7 = FUN_010303fa((uStack_44 & 0xffff) - 2000 & 0xffff);
              *(undefined1 *)(iStack_b8 + 0xd) = uVar7;
              uVar7 = FUN_010303fa(uStack_44._2_1_);
              *(undefined1 *)(iStack_b8 + 0xe) = uVar7;
              uVar7 = FUN_010303fa(uStack_44._3_1_);
              *(undefined1 *)(iStack_b8 + 0xf) = uVar7;
              uVar7 = FUN_010303fa(uStack_3f);
              *(undefined1 *)(iStack_b8 + 0x10) = uVar7;
              uVar7 = FUN_010303fa(uStack_3e);
              *(undefined1 *)(iStack_b8 + 0x11) = uVar7;
              uVar7 = FUN_010303fa(uStack_3d);
              *(undefined1 *)(iStack_b8 + 0x12) = uVar7;
            }
            else if (0 < *piVar6) {
              FUN_0104ba04(PTR_s___s__s__s___srtc_error__s_01039640,PTR_s_usbiap2_01039628,
                           PTR_s__ERR__01039624,PTR_s_usbiap2_get_sys_time_0103963c,puVar4,puVar4);
            }
            uStack_54 = 7;
            goto LAB_010395a2;
          }
          iVar11 = *piVar6;
          puVar15 = PTR_s_usbiap2_get_sys_time_0103963c;
joined_r0x01039b24:
          if (0 < iVar11) {
            FUN_0104ba04(puVar17,puVar18,puVar19,puVar15,puVar4,puVar4);
          }
          goto LAB_010394e2;
        }
        if (uStack_bc < 3) {
          if (uStack_bc != 1) goto LAB_010390a6;
          if ((iStack_b8 + 0xc == 0) || (uVar23 == 0)) {
            iVar11 = *piVar6;
            puVar15 = PTR_s_usbiap2_get_device_info_01039630;
          }
          else {
            puVar12 = (undefined1 *)FUN_0105a24c(0xd);
            if (puVar12 != (undefined1 *)0x0) {
              iVar11 = FUN_0106ccc0();
              uVar7 = (undefined1)*(undefined4 *)(iVar11 + 4);
              uVar25 = (undefined1)((uint)*(undefined4 *)(iVar11 + 4) >> 8);
              uStack_44 = CONCAT31(CONCAT21(CONCAT11(uVar7,uVar25),uVar25),uVar7);
              func_0x000800aa(iStack_b8 + 0xc,&uStack_44,4);
              uStack_54 = 4;
              iVar11 = FUN_0105b518(puVar12);
              if (iVar11 != 0xd) {
                iVar24 = *piVar6;
                puVar17 = PTR_s_usbiap2_get_device_info_01039630;
                goto joined_r0x0103952e;
              }
              func_0x000800aa(iStack_b8 + 0x10,puVar12,0xd);
              uStack_54 = uStack_54 + 0xd;
              goto LAB_0103a15a;
            }
            iVar11 = *piVar6;
            puVar17 = PTR_s___s__s__s___smalloc_error__s_01039634;
            puVar19 = PTR_s__ERR__01039624;
            puVar18 = PTR_s_usbiap2_01039628;
            puVar15 = PTR_s_usbiap2_get_device_info_01039630;
          }
          goto joined_r0x01039b24;
        }
        if (uStack_bc == 3) goto LAB_01039256;
        if (uStack_bc != 4) goto LAB_010390a6;
        iVar11 = iStack_b8 + 0xc;
        uStack_50 = (uint)uStack_50._1_3_ << 8;
        uStack_4c = uStack_4c & 0xffffff00;
        if (iVar11 == 0) {
          piVar26 = (int *)0x0;
          iStack_94 = 0;
          iStack_98 = 0;
          uStack_a8 = 0;
          uStack_a4 = 0xffffffff;
        }
        else {
          if (uStack_a0 == 0) {
            FUN_0102f3fc(0,&uStack_4c);
            puVar18 = PTR_DAT_0103964c;
            puVar19 = PTR_DAT_01039648;
            puVar17 = PTR_DAT_01039644;
            if (3 < (uStack_4c & 0xff)) {
              *pcVar28 = '\x01';
              uStack_a4 = FUN_0102f3fc(4,&uStack_44);
LAB_010391e6:
              *(undefined1 *)(iStack_b8 + 0xc) = 0xff;
              *(undefined1 *)(iStack_b8 + 0xd) = 0xff;
              uVar7 = (undefined1)(uStack_44 >> 8);
              uStack_44 = CONCAT31(CONCAT21(CONCAT11((char)uStack_44,uVar7),uVar7),(char)uStack_44);
              func_0x000800aa(iStack_b8 + 0xe,&uStack_44,4);
              iStack_88 = 0;
              uStack_a8 = 6;
              goto LAB_0103920a;
            }
            *pcVar28 = '\0';
            uStack_a4 = FUN_0105aa84(puVar18,puVar19,puVar17,&uStack_44);
            if (uStack_a4 == 0) {
              uStack_48 = uStack_48 & 0xffffff00;
              FUN_0102d828(10,&uStack_48);
              if (((char)uStack_48 != '\0') && (uStack_44 != 0)) {
                uStack_44 = uStack_44 - 1;
              }
              goto LAB_010391e6;
            }
            if (0 < *piVar6) {
              FUN_0104ba04(PTR_s___s__s__s___sget_file_num_error___010397fc,PTR_s_usbiap2_01039808,
                           PTR_s__ERR__01039804,PTR_s_usbiap2_get_files_information_01039800,puVar4,
                           puVar4);
            }
            uStack_a8 = 0;
            uVar14 = uStack_a8;
          }
          else {
            iStack_88 = uStack_a0 - 6;
            uStack_a8 = 0;
            uStack_a4 = 0xffffffff;
LAB_0103920a:
            if (*pcVar28 == '\0') {
              iStack_98 = FUN_0105a24c(0x44);
              iStack_94 = FUN_0105a24c(0x208);
              piVar26 = (int *)FUN_0105a24c(0x39);
              puVar17 = PTR_DAT_0103980c;
              if (((iStack_98 != 0) && (iStack_94 != 0)) && (piVar26 != (int *)0x0)) {
                func_0x0008009e(iStack_98,0,0x44);
                uStack_a4 = FUN_01066b50(iStack_98,puVar17);
                if (uStack_a4 == 0) {
                  iStack_68 = func_0x0000050c(iStack_88,0x39);
                  iStack_84 = func_0x00000558(iStack_88,0x39);
LAB_010398b4:
                  while( true ) {
                    do {
                      iVar24 = iStack_94 + 1;
                      do {
                        iVar13 = FUN_01066b70(iStack_98,iStack_94);
                        if ((iVar13 != 0) || (*(char *)(iStack_94 + 1) == '\0')) {
                          if (1 < *piVar6) {
                            FUN_0104ba04(PTR_s___s__s__s___sreaddir__s_finish__l_01039a14,
                                         PTR_s_usbiap2_01039a04,PTR_s__WRN__01039a10,
                                         PTR_s_usbiap2_get_files_information_01039a0c,puVar4,puVar17
                                         ,uStack_a8,iVar13,puVar4);
                          }
                          FUN_01066bd0(iStack_98);
                          goto LAB_01039706;
                        }
                        uVar14 = func_0x000800d2(iVar24);
                      } while (0x1b < uVar14);
                      iVar13 = FUN_0108defc(iVar24,PTR_DAT_01039a18);
                    } while ((iVar13 == 0) &&
                            (iVar13 = FUN_0108defc(iVar24,PTR_DAT_01039be0), iVar13 == 0));
                    if (iStack_68 == 0) break;
                    iStack_68 = iStack_68 + -1;
                  }
                  *(undefined1 *)piVar26 = 0;
                  *(undefined1 *)((int)piVar26 + 1) = 0;
                  *(undefined1 *)((int)piVar26 + 2) = 0;
                  *(undefined1 *)((int)piVar26 + 3) = 0x1b;
                  func_0x0008009e(piVar26 + 1,0,0x1b);
                  uVar10 = func_0x000800d2(iVar24);
                  func_0x000800aa(piVar26 + 1,iVar24,uVar10);
                  uVar7 = (undefined1)*(undefined4 *)(iStack_94 + 0x204);
                  uVar25 = (undefined1)((uint)*(undefined4 *)(iStack_94 + 0x204) >> 8);
                  *(undefined1 *)((int)piVar26 + 0x1f) = uVar7;
                  *(undefined1 *)(piVar26 + 8) = uVar25;
                  *(undefined1 *)((int)piVar26 + 0x21) = uVar25;
                  *(undefined1 *)((int)piVar26 + 0x22) = uVar7;
                  iVar13 = FUN_01037e28(iVar24,(undefined1 *)((int)piVar26 + 0x29),&uStack_50);
                  if (iVar13 != 0) goto code_r0x01039972;
                  goto LAB_0103999c;
                }
                if (0 < *piVar6) {
                  FUN_0104ba04(PTR_s___s__s__s___sopendir__s_failed___01039810,
                               PTR_s_usbiap2_01039808,PTR_s__ERR__01039804,
                               PTR_s_usbiap2_get_files_information_01039800,puVar4,puVar17,uStack_a4
                               ,puVar4);
                }
              }
              goto LAB_01039706;
            }
            uStack_a4 = FUN_0102e604(iVar11 + uStack_a8,uVar23 - uStack_a8,iStack_88);
            if ((uStack_a4 & 0x80000000) == 0) {
              uVar14 = uVar23;
              if (uVar23 - uStack_a8 != uStack_a4) {
                piVar26 = (int *)0x0;
                iStack_94 = 0;
                iStack_98 = 0;
                uStack_a8 = uStack_a8 + uStack_a4;
                uStack_a4 = 0;
                goto LAB_01039706;
              }
            }
            else {
              uStack_a8 = 0;
              uVar14 = uStack_a8;
            }
          }
          uStack_a8 = uVar14;
          iStack_94 = 0;
          iStack_98 = 0;
          piVar26 = (int *)0x0;
        }
        goto LAB_01039706;
      }
      if (uStack_bc < 0xf006) {
        if ((0xf003 < uStack_bc) || (uStack_bc == 0x21)) goto LAB_01039256;
        if (0x21 < uStack_bc) {
          if (uStack_bc == 0xf001) {
            uStack_48 = 0;
            uStack_44 = 0;
            if ((iStack_b8 + 0xc == 0) || (uVar23 == 0)) {
              iVar11 = *piVar6;
              puVar15 = PTR_s_usbiap2_get_version_0103a448;
            }
            else {
              iVar11 = FUN_0106ccc0();
              uVar7 = (undefined1)*(undefined4 *)(iVar11 + 4);
              uVar25 = (undefined1)((uint)*(undefined4 *)(iVar11 + 4) >> 8);
              uStack_48 = CONCAT31(CONCAT21(CONCAT11(uVar7,uVar25),uVar25),uVar7);
              func_0x000800aa(iStack_b8 + 0xc,&uStack_48,4);
              uStack_54 = 4;
              puVar12 = (undefined1 *)FUN_0105a24c(0x1c);
              if (puVar12 != (undefined1 *)0x0) {
                iVar11 = FUN_01021624(0xe,puVar12);
                if (iVar11 == 0) {
                  iVar11 = FUN_0108defc(puVar12,PTR_DAT_0103a450);
                  if (iVar11 != 0) {
                    pcVar28 = (char *)(iVar11 + 4);
                    if (2 < *piVar6) {
                      FUN_0104ba04(PTR_s___s__s__s___sdsp_ver___s_ver___s_0103a45c,
                                   PTR_s_usbiap2_0103a440,PTR_s__INF__0103a458,
                                   PTR_s_usbiap2_get_version_0103a448,puVar4,puVar12,pcVar28,puVar4)
                      ;
                    }
                    uStack_48 = 0;
                    do {
                      if (pcVar28[1] == '_') {
                        uVar14 = (int)*pcVar28 - 0x30U | uStack_48;
                      }
                      else {
                        uVar14 = (((int)*pcVar28 - 0x30U) * 10 | uStack_48) + pcVar28[1] + -0x30;
                      }
                      pcVar28 = pcVar28 + 2;
                      uStack_48 = uVar14 << 8;
                    } while (pcVar28 != (char *)(iVar11 + 10));
                    uStack_48 = uVar14 << 0x18 | uStack_48 & 0xff0000 |
                                (uVar14 & 0xffffff) >> 8 & 0xff00;
                    func_0x000800aa(iStack_b8 + 0x10,&uStack_48,4);
                    uStack_54 = uStack_54 + 4;
                    uStack_44 = 0xf;
                    FUN_01022c88(1,&uStack_44);
                    FUN_0108fad8(10);
                    uStack_48 = 0;
                    iVar11 = FUN_01024174(0x3e0,&uStack_48,4,1000);
                    if (iVar11 != 0) {
                      if (0 < *piVar6) {
                        FUN_0104ba04(PTR_s___s__s__s___suac_get_fw_err__s_0103a460,
                                     PTR_s_usbiap2_0103a440,PTR_s__ERR__0103a43c,
                                     PTR_s_usbiap2_get_version_0103a448,puVar4,puVar4);
                      }
                      uStack_48 = 0;
                    }
                    uStack_44 = 0xf1;
                    FUN_01022c88(1,&uStack_44);
                    func_0x000800aa(iStack_b8 + 0x14,&uStack_48,4);
                    uStack_54 = uStack_54 + 4;
                    cVar8 = '\0';
                    uStack_48 = 0;
                    iVar11 = iStack_b8 + 0x18;
                    uVar7 = 3;
                    while( true ) {
                      uStack_4c = CONCAT31(uStack_4c._1_3_,uVar7);
                      FUN_010289ec(2,&uStack_4c);
                      uStack_48 = FUN_01029a2a(0);
                      if (uStack_48 == 0) {
                        if (0 < *piVar6) {
                          FUN_0104ba04(PTR_s___s__s__s___sig_get_fw_err__s_0103a650,
                                       PTR_s_usbiap2_0103a65c,PTR_s__ERR__0103a658,
                                       PTR_s_usbiap2_get_version_0103a654,puVar4,puVar4);
                        }
                      }
                      else {
                        if (2 < *piVar6) {
                          FUN_0104ba04(PTR_s___s__s__s___sig_FW_ver___08X__s_0103a664,
                                       PTR_s_usbiap2_0103a65c,PTR_s__INF__0103a660,
                                       PTR_s_usbiap2_get_version_0103a654,puVar4,uStack_48,puVar4);
                        }
                        uVar7 = (undefined1)(uStack_48 >> 8);
                        uStack_48 = CONCAT31(CONCAT21(CONCAT11((char)uStack_48,uVar7),uVar7),
                                             (char)uStack_48);
                        if ((uStack_4c & 0xff) == 2) {
                          uStack_48 = 0;
                        }
                        func_0x000800aa(iVar11,&uStack_48,4);
                        uStack_54 = uStack_54 + 4;
                      }
                      uStack_4c = CONCAT31(uStack_4c._1_3_,1);
                      cVar8 = cVar8 + '\x01';
                      FUN_010289ec(2,&uStack_4c);
                      FUN_0108fad8(0x32);
                      if (cVar8 == '\x02') break;
                      iVar11 = iVar11 + 4;
                      uVar7 = 2;
                    }
                    uStack_48 = 0;
                    FUN_010302cc(4,&uStack_48);
                    func_0x000800aa(iStack_b8 + 0x20,&uStack_48,4);
                    uStack_54 = uStack_54 + 4;
                    uStack_48 = 0;
                    FUN_010302cc(5,&uStack_48);
                    func_0x000800aa(iStack_b8 + 0x24,&uStack_48,4);
                    uStack_54 = uStack_54 + 4;
                    goto LAB_0103a15a;
                  }
                  iVar11 = *piVar6;
                  puVar17 = PTR_s___s__s__s___sdsp_fw_error__s_0103a454;
                }
                else {
                  iVar11 = *piVar6;
                  puVar17 = PTR_s___s__s__s___sdsp_get_fw_error__s_0103a44c;
                }
                if (0 < iVar11) {
                  FUN_0104ba04(puVar17,PTR_s_usbiap2_0103a440,PTR_s__ERR__0103a43c,
                               PTR_s_usbiap2_get_version_0103a448,puVar4,puVar4);
                }
LAB_0103a15a:
                FUN_0105a260(puVar12);
                goto LAB_010394e2;
              }
              iVar11 = *piVar6;
              puVar17 = PTR_s___s__s__s___smalloc_error__s_01039634;
              puVar19 = PTR_s__ERR__01039624;
              puVar18 = PTR_s_usbiap2_01039628;
              puVar15 = PTR_s_usbiap2_get_version_0103a448;
            }
            goto joined_r0x01039b24;
          }
          if (0xf001 < uStack_bc) {
            if (uStack_bc == 0xf002) goto LAB_01039256;
            if (uStack_bc != 0xf003) goto LAB_010390a6;
            uStack_48 = (uint)uStack_48._1_3_ << 8;
            uStack_44 = (uint)uStack_44._1_3_ << 8;
            if ((iStack_b8 + 0xc == 0) || (uVar23 == 0)) {
              iVar11 = *piVar6;
              puVar15 = PTR_s_usbiap2_get_key_val_01039438;
              goto joined_r0x01039b24;
            }
            uVar14 = FUN_0105b620(&uStack_48);
            if (uVar14 == 1) {
              uVar14 = FUN_01028344(1,&uStack_44);
              if (uVar14 != 0) {
                iVar11 = *piVar6;
                puVar17 = PTR_s_usbiap2_0103a65c;
                puVar19 = PTR_s_usbiap2_get_key_val_0103a66c;
                puVar18 = PTR_s__ERR__0103a658;
                puVar15 = PTR_s___s__s__s___sget_pot_value_error_0103a674;
                goto joined_r0x01039b48;
              }
              func_0x000800aa(iStack_b8 + 0xc,&uStack_48,1);
              uStack_54 = 1;
              func_0x000800aa(iStack_b8 + 0xd,&uStack_44,1);
              uStack_54 = uStack_54 + 1;
              goto LAB_010394e2;
            }
            iVar11 = *piVar6;
            puVar18 = PTR_s__ERR__0103a658;
            puVar17 = PTR_s_usbiap2_0103a65c;
            puVar19 = PTR_s_usbiap2_get_key_val_0103a66c;
            puVar15 = PTR_s___s__s__s___sget_key_value_error_0103a670;
            goto joined_r0x0103a5be;
          }
          if (uStack_bc != 0x22) goto LAB_010390a6;
          uStack_50 = (uint)uStack_50._1_3_ << 8;
          uStack_4c = 0;
          uStack_48 = 0;
          uStack_44 = 0;
          if ((iStack_b8 + 0xc == 0) || (uVar23 == 0)) {
            iVar11 = *piVar6;
            puVar15 = PTR_s_usbiap2_get_live_audio_stream_01039434;
            goto joined_r0x010393a0;
          }
          FUN_01032368(1,&uStack_50);
          if ((uStack_50 & 0xff) != 0) {
            iVar11 = FUN_01032368(4,&uStack_4c);
            if ((iVar11 != 0) || (uStack_4c == 0)) goto LAB_0103a04c;
            FUN_01027ed4(2,&uStack_48);
            uVar7 = (undefined1)(uStack_4c - 1);
            uVar25 = (undefined1)(uStack_4c - 1 >> 8);
            uStack_4c = CONCAT31(CONCAT21(CONCAT11(uVar7,uVar25),uVar25),uVar7);
            func_0x000800aa(iStack_b8 + 0xc,&uStack_4c,4);
            uVar7 = (undefined1)(uStack_48 >> 8);
            uStack_48 = CONCAT31(CONCAT21(CONCAT11((char)uStack_48,uVar7),uVar7),(char)uStack_48);
            func_0x000800aa(iStack_b8 + 0x10,&uStack_48,4);
            FUN_01032368(5,&uStack_44);
            if (uVar23 < uStack_44) {
              uStack_44 = uVar23 - 8;
            }
            uVar14 = FUN_0103200c(6,&uStack_44);
            if (uVar14 != 0) {
              uStack_54 = 0;
              iVar11 = *piVar6;
              puVar17 = PTR_s___s__s__s___sset_live_frame_len_e_0103a434;
              puVar19 = PTR_s_usbiap2_get_live_audio_stream_0103a438;
              puVar18 = PTR_s__ERR__0103a43c;
              puVar15 = PTR_s_usbiap2_0103a440;
              goto joined_r0x0103a27e;
            }
            uVar14 = FUN_01032368(7,iStack_b8 + 0x14);
            if ((uVar14 & 0x80000000) != 0) {
              uStack_54 = 0;
              iVar11 = *piVar6;
              puVar17 = PTR_s___s__s__s___sget_live_audio_data_0103a444;
              puVar19 = PTR_s__ERR__0103a43c;
              puVar18 = PTR_s_usbiap2_0103a440;
              puVar15 = PTR_s_usbiap2_get_live_audio_stream_0103a438;
              goto joined_r0x01039b24;
            }
            uStack_54 = uVar14 + 8;
          }
          goto LAB_010394e2;
        }
        if (uStack_bc == 0x1c) goto LAB_01039256;
        if (0x1c < uStack_bc) {
          if (uStack_bc == 0x1d) {
            uStack_4c = (uint)uStack_4c._1_3_ << 8;
            uStack_48 = (uint)uStack_48._1_3_ << 8;
            uStack_44 = uStack_44 & 0xffff0000;
            if ((iStack_b8 != -0xc) && (uVar23 != 0)) {
              FUN_0102d828(10,&uStack_4c);
              if ((char)uStack_4c != '\0') {
                puVar27 = (undefined1 *)(iStack_b8 + 0xd);
                *(undefined1 *)(iStack_b8 + 0xc) = 0;
                uStack_54 = 1;
                iVar11 = FUN_0105a24c(0x21);
                if (iVar11 != 0) {
                  FUN_0102d828(0x12,iVar11);
                  uVar14 = func_0x000800d2(iVar11);
                  if (4 < uVar14) {
                    cVar8 = func_0x000800d2(iVar11);
                    uVar14 = (uint)(byte)(cVar8 - 4U);
                    if (uVar14 != 0) {
                      *(byte *)(iStack_b8 + 0xd) = cVar8 - 4U;
                      uStack_54 = uStack_54 + 1;
                      func_0x000800aa(iStack_b8 + 0xe,iVar11 + 4,uVar14);
                      puVar27 = (undefined1 *)(iStack_b8 + 0xe + uVar14);
                      uStack_54 = uVar14 + uStack_54;
                    }
                  }
                  FUN_0105a260(iVar11);
                  FUN_0102d828(0xb,&uStack_44);
                  puVar27[1] = (char)uStack_44;
                  *puVar27 = (char)(uStack_44 >> 8);
                  uStack_54 = uStack_54 + 2;
                  FUN_0102d828(0xd,&uStack_48);
                  if ((uStack_48 & 0xff) == 0) {
                    puVar12 = (undefined1 *)0x0;
                  }
                  else {
                    puVar12 = (undefined1 *)FUN_0105a24c((uStack_48 & 0xff) + 5);
                    if (puVar12 == (undefined1 *)0x0) goto LAB_0103a04c;
                    *puVar12 = (char)uStack_48;
                    uVar14 = FUN_0102d828(0xc,puVar12);
                    if ((uVar14 & 0x80000000) == 0) {
                      uVar7 = *puVar12;
                    }
                    else {
                      uVar7 = 0;
                    }
                    uStack_48 = CONCAT31(uStack_48._1_3_,uVar7);
                  }
                  if ((uStack_48 & 0xff) == 0) {
                    puVar27[2] = 0;
                    uStack_54 = uStack_54 + 1;
                  }
                  else {
                    func_0x000800aa(puVar27 + 2,puVar12,(uStack_48 & 0xff) + 1);
                    uStack_54 = uStack_54 + 1 + (uStack_48 & 0xff);
                    puVar27 = puVar12;
                    puVar17 = PTR_s__02x_0103a1e8;
                    if (2 < *piVar6) {
                      FUN_0104ba04(PTR_s___s__s__s___smemcpy_count__d__da_0103a1e4,
                                   PTR_s_usbiap2_0103a1e0,PTR_s__INF__0103a1dc,
                                   PTR_s_usbiap2_get_recording_amplitude_0103a1d8,puVar4,
                                   uStack_48 & 0xff,puVar4);
                      puVar17 = PTR_s__02x_0103a1e8;
                    }
                    for (; (int)puVar27 - (int)puVar12 < (int)((uStack_48 & 0xff) + 1);
                        puVar27 = puVar27 + 1) {
                      FUN_0104ba04(puVar17,*puVar27);
                    }
                    FUN_0104ba04(PTR_s__010e5bdb_0x2a_0103a1ec);
                  }
                  if (puVar12 != (undefined1 *)0x0) goto LAB_0103a15a;
                  goto LAB_010394e2;
                }
              }
LAB_0103a04c:
              uStack_54 = 0;
              goto LAB_010394e2;
            }
            iVar11 = *piVar6;
            puVar15 = PTR_s_usbiap2_get_recording_amplitude_0103a1d8;
          }
          else {
            if (uStack_bc != 0x20) goto LAB_010390a6;
            uStack_44 = 0;
            if ((iStack_b8 + 0xc != 0) && (uVar23 != 0)) {
              uVar14 = FUN_01032368(3,&uStack_44);
              iVar11 = *piVar6;
              puVar17 = PTR_s___s__s__s___sget_live_audio_form_0103a1f0;
              puVar19 = PTR_s_usbiap2_get_live_audio_format_0103a1f4;
              puVar18 = PTR_s__ERR__0103a1f8;
              puVar15 = PTR_s_usbiap2_0103a1e0;
              if (uVar14 != 0) {
joined_r0x0103a27e:
                if (0 < iVar11) {
                  FUN_0104ba04(puVar17,puVar15,puVar18,puVar19,puVar4,puVar4);
                }
                goto LAB_010395a2;
              }
              if (2 < iVar11) {
                FUN_0104ba04(PTR_s___s__s__s___sget_live_format___d_0103a1fc,PTR_s_usbiap2_0103a1e0,
                             PTR_s__INF__0103a1dc,PTR_s_usbiap2_get_live_audio_format_0103a1f4,
                             puVar4,uStack_44,puVar4);
              }
              uVar7 = (undefined1)(uStack_44 >> 8);
              uStack_44 = CONCAT31(CONCAT21(CONCAT11((char)uStack_44,uVar7),uVar7),(char)uStack_44);
              func_0x000800aa(iStack_b8 + 0xc,&uStack_44,4);
              uStack_54 = 4;
              goto LAB_010394e2;
            }
            iVar11 = *piVar6;
            puVar15 = PTR_s_usbiap2_get_live_audio_format_01039430;
joined_r0x010393a0:
            uStack_44 = 0;
          }
          goto joined_r0x01039b24;
        }
        if (uStack_bc != 0x1a) goto LAB_010390a6;
        iVar11 = FUN_01038884(uStack_80,uStack_9c,iStack_b8 + 0xc,uVar23,uStack_a0,&uStack_54);
        bVar1 = iVar11 < 1;
      }
      else {
        if (uStack_bc != 0xf00b) {
          if (0xf00b < uStack_bc) {
            if (0xf010 < uStack_bc) {
              if (uStack_bc == 0xf011) {
                uStack_44 = 0;
                if ((iStack_b8 + 0xc != 0) && (uVar23 != 0)) {
                  if (*piVar5 != 0) {
                    uStack_44 = *(undefined4 *)(*piVar5 + 0x34);
                    if (2 < *piVar6) {
                      FUN_0104ba04(PTR_s___s__s__s___sget_write_timeout___0103a810,
                                   PTR_s_usbiap2_0103a800,PTR_s__INF__0103a804,
                                   PTR_s_usbiap2_get_usb_timeout_0103a80c,puVar4,uStack_44,puVar4);
                    }
                    uVar7 = (undefined1)(uStack_44 >> 8);
                    uStack_44 = CONCAT31(CONCAT21(CONCAT11((char)uStack_44,uVar7),uVar7),
                                         (char)uStack_44);
                    func_0x000800aa(iStack_b8 + 0xc,&uStack_44,4);
                    uStack_54 = uStack_54 + 4;
                  }
                  goto LAB_010394e2;
                }
                iVar11 = *piVar6;
                puVar15 = PTR_s_usbiap2_get_usb_timeout_0103962c;
                goto joined_r0x01039b24;
              }
LAB_010390a6:
              uStack_54 = 0;
              iVar11 = *piVar6;
              uVar14 = uStack_bc;
              puVar18 = PTR_s__ERR__010391b0;
              puVar17 = PTR_s_usbiap2_01039198;
              puVar19 = PTR_s_usbiap2_hinotes_protocol_structu_01039194;
              puVar15 = PTR_s___s__s__s___siap2_cmd_not_suppor_010391b4;
joined_r0x0103a5be:
              if (0 < iVar11) goto LAB_01039b5c;
              goto LAB_010394e2;
            }
            if (0xf00e < uStack_bc) goto LAB_01039256;
            if (uStack_bc != 0xf00e) goto LAB_010390a6;
            iVar11 = iStack_b8 + 0xc;
            uStack_44 = 0;
            if ((iVar11 == 0) || (uVar23 == 0)) {
              if (0 < *piVar6) {
                FUN_0104ba04(PTR_s___s__s__s___sout_buf_error__s_0103961c,PTR_s_usbiap2_01039628,
                             PTR_s__ERR__01039624,PTR_s_usbiap2_get_mfi_device_id_01039620,puVar4,
                             puVar4);
              }
              uVar14 = 0xffffffff;
            }
            else {
              uVar14 = FUN_0101c018(0x10,4,0,0);
              if (uVar14 == 0) {
                uVar14 = FUN_0101c140(0x10,4,&uStack_44,4);
                iVar24 = *piVar6;
                puVar17 = PTR_s___s__s__s___smfi_iic_read_error___0103a7f4;
                puVar19 = PTR_s_usbiap2_get_mfi_device_id_0103a7f8;
                puVar18 = PTR_s__ERR__0103a7fc;
                puVar15 = PTR_s_usbiap2_0103a800;
                if (uVar14 == 0) {
                  if (2 < iVar24) {
                    FUN_0104ba04(PTR_s___s__s__s___sMFI_device_id___d___0103a808,
                                 PTR_s_usbiap2_0103a800,PTR_s__INF__0103a804,
                                 PTR_s_usbiap2_get_mfi_device_id_0103a7f8,puVar4,uStack_44 & 0xff,
                                 uStack_44 >> 8 & 0xff,uStack_44 >> 0x10 & 0xff,uStack_44 >> 0x18,
                                 puVar4);
                  }
                  goto LAB_01039eec;
                }
              }
              else {
                iVar24 = *piVar6;
                puVar17 = PTR_s___s__s__s___smfi_iic_write_error_0103a678;
                puVar19 = PTR_s_usbiap2_get_mfi_device_id_0103a67c;
                puVar18 = PTR_s__ERR__0103a658;
                puVar15 = PTR_s_usbiap2_0103a65c;
              }
              if (0 < iVar24) {
                FUN_0104ba04(puVar17,puVar15,puVar18,puVar19,puVar4,puVar4);
              }
            }
LAB_01039eec:
            func_0x000800aa(iVar11,&uStack_44,4);
            uStack_54 = uStack_54 + 4;
LAB_010395a2:
            bVar1 = (int)uVar14 < 1;
            goto LAB_01039756;
          }
          if (0xf009 < uStack_bc) goto LAB_01039b08;
          if (uStack_bc < 0xf007) {
            if ((iStack_b8 + 0xc == 0) || (uVar23 == 0)) {
              iVar11 = *piVar6;
              puVar15 = PTR_s_usbiap2_get_device_sn_0103943c;
            }
            else {
              puVar12 = (undefined1 *)FUN_0105a24c(0xd);
              if (puVar12 != (undefined1 *)0x0) {
                iVar11 = FUN_0105b518();
                if (iVar11 == 0xd) {
                  func_0x000800aa(iStack_b8 + 0xc,puVar12,0xd);
                  uStack_54 = 0xd;
                }
                else {
                  iVar24 = *piVar6;
                  puVar17 = PTR_s_usbiap2_get_device_sn_0103a668;
joined_r0x0103952e:
                  if (0 < iVar24) {
                    FUN_0104ba04(PTR_s___s__s__s___sget_sn_error__d__s_01039638,
                                 PTR_s_usbiap2_01039628,PTR_s__ERR__01039624,puVar17,puVar4,iVar11,
                                 puVar4);
                  }
                }
                goto LAB_0103a15a;
              }
              iVar11 = *piVar6;
              puVar17 = PTR_s___s__s__s___smalloc_error__s_01039634;
              puVar19 = PTR_s__ERR__01039624;
              puVar18 = PTR_s_usbiap2_01039628;
              puVar15 = PTR_s_usbiap2_get_device_sn_0103a668;
            }
            goto joined_r0x01039b24;
          }
        }
LAB_01039256:
        uStack_54 = 1;
        func_0x000800aa(iStack_b8 + 0xc,&cStack_55,1);
LAB_010394e2:
        bVar1 = true;
      }
      goto LAB_01039756;
    }
    iStack_b8 = FUN_0104f66c();
    if (iStack_b8 != 0) {
      iVar11 = FUN_0104f674();
      uVar23 = iVar11 - 0xc;
      goto LAB_01039058;
    }
    if (0 < *DAT_010391a0) {
      FUN_0104ba04(PTR_s___s__s__s___sdata_buf_is_NULL_____010391bc,PTR_s_usbiap2_01039198,
                   PTR_s__ERR__010391b0,PTR_s_usbiap2_hinotes_protocol_structu_01039194,
                   PTR_s__010f8ede_0x1b_010391a4,PTR_s__010f8ede_0x1b_010391a4);
    }
LAB_0103912a:
    if (((uStack_bc != 5) && (uStack_bc != 0xf00a)) && ((uStack_bc != 0xd && (uStack_bc != 0x15))))
    {
      return uStack_b0;
    }
    if (iStack_8c != 0) {
      FUN_0105a260(iStack_8c);
    }
  }
  else {
    if ((((uStack_bc != 5) && (uStack_bc != 0xf00a)) && (uStack_bc != 0xd)) && (uStack_bc != 0x15))
    {
      uStack_9c = 0;
      iStack_8c = 0;
      iStack_90 = 0;
      uStack_a0 = 0;
      uStack_b0 = 0xffffffff;
LAB_01039012:
      uStack_80 = uStack_a0;
      if (uStack_bc == 0x1a) {
        uVar20 = (undefined1)*(undefined4 *)param_2;
        uVar7 = (undefined1)((uint)*(undefined4 *)param_2 >> 8);
        uStack_80 = CONCAT31(CONCAT21(CONCAT11(uVar20,uVar7),uVar7),uVar20);
        uVar20 = (undefined1)*(undefined4 *)(param_2 + 4);
        uVar7 = (undefined1)((uint)*(undefined4 *)(param_2 + 4) >> 8);
        uStack_9c = CONCAT31(CONCAT21(CONCAT11(uVar20,uVar7),uVar7),uVar20);
        if (2 < *DAT_010391a0) {
          FUN_0104ba04(PTR_s___s__s__s___soff__d_num__d__s_010391a8,PTR_s_usbiap2_01039198,
                       PTR_s__INF__010391ac,PTR_s_usbiap2_hinotes_protocol_structu_01039194,
                       PTR_s__010f8ede_0x1b_010391a4,uStack_80,uStack_9c,
                       PTR_s__010f8ede_0x1b_010391a4);
        }
      }
      goto LAB_01039046;
    }
    func_0x0008009e(auStack_38,0,0x21);
    FUN_0108df26(auStack_38,PTR_DAT_01038ffc);
    if (uStack_bc == 0xd) {
      uVar20 = (undefined1)*(undefined4 *)param_2;
      uVar7 = (undefined1)((uint)*(undefined4 *)param_2 >> 8);
      uStack_9c = CONCAT31(CONCAT21(CONCAT11(uVar20,uVar7),uVar7),uVar20);
      param_2 = param_2 + 4;
LAB_01038f00:
      uStack_a0 = 0;
    }
    else {
      if (uStack_bc != 0x15) {
        uStack_9c = 0;
        goto LAB_01038f00;
      }
      uVar20 = (undefined1)*(undefined4 *)param_2;
      uVar7 = (undefined1)((uint)*(undefined4 *)param_2 >> 8);
      uStack_a0 = CONCAT31(CONCAT21(CONCAT11(uVar20,uVar7),uVar7),uVar20);
      uVar20 = (undefined1)*(undefined4 *)(param_2 + 4);
      uVar7 = (undefined1)((uint)*(undefined4 *)(param_2 + 4) >> 8);
      uStack_9c = CONCAT31(CONCAT21(CONCAT11(uVar20,uVar7),uVar7),uVar20);
      param_2 = param_2 + 8;
    }
    FUN_0108df26(auStack_38,param_2);
    iStack_90 = FUN_0105a24c(0x40);
    if (iStack_90 == 0) {
      if (0 < *DAT_01038fdc) {
        FUN_0104ba04(PTR_s___s__s__s___serr_fs_malloc__s_01039000,PTR_s_usbiap2_01038fe8,
                     PTR_s__ERR__01038fe4,PTR_s_usbiap2_hinotes_protocol_structu_01038ff0,
                     PTR_s__010f8ede_0x1b_01038fe0,PTR_s__010f8ede_0x1b_01038fe0);
      }
      if (uStack_bc == 5) {
        return 0xffffffff;
      }
      if (uStack_bc == 0xf00a) {
        return 0xffffffff;
      }
    }
    else {
      iStack_8c = FUN_0105a24c(0x208);
      if (iStack_8c != 0) {
        uStack_b0 = FUN_01066bf0(auStack_38,iStack_8c);
        if ((uStack_b0 & 0x80000000) == 0) {
          uStack_b0 = FUN_01066948(iStack_90,auStack_38);
          if (uStack_b0 == 0) goto LAB_01039012;
          iVar11 = *DAT_010391a0;
          puVar4 = PTR_s__010f8ede_0x1b_010391a4;
          puVar17 = PTR_s__ERR__010391b0;
          puVar19 = PTR_s___s__s__s___scannot_open__s_file_010391b8;
        }
        else {
          iVar11 = *DAT_01038fdc;
          puVar4 = PTR_s__010f8ede_0x1b_01038fe0;
          puVar17 = PTR_s__ERR__01038fe4;
          puVar19 = PTR_s___s__s__s___scannot_find_file__s_0103919c;
        }
        if (0 < iVar11) {
          FUN_0104ba04(puVar19,PTR_s_usbiap2_01039198,puVar17,
                       PTR_s_usbiap2_hinotes_protocol_structu_01039194,puVar4,auStack_38,uStack_b0,
                       puVar4);
        }
        goto LAB_01039012;
      }
      if (0 < *DAT_01038fdc) {
        FUN_0104ba04(PTR_s___s__s__s___serr_fs_dirent_mallo_01039004,PTR_s_usbiap2_01038fe8,
                     PTR_s__ERR__01038fe4,PTR_s_usbiap2_hinotes_protocol_structu_01038ff0,
                     PTR_s__010f8ede_0x1b_01038fe0,PTR_s__010f8ede_0x1b_01038fe0);
      }
      if ((uStack_bc == 5) || (uStack_bc == 0xf00a)) {
        uStack_b0 = 0xffffffff;
        goto LAB_01038fa6;
      }
    }
    if ((uStack_bc != 0xd) && (uStack_bc != 0x15)) {
      return 0xffffffff;
    }
    uStack_b0 = 0xffffffff;
  }
  if (iStack_90 == 0) {
    return uStack_b0;
  }
LAB_01038fa6:
  FUN_01066968(iStack_90);
  FUN_0105a260(iStack_90);
  return uStack_b0;
code_r0x01039972:
  iVar24 = FUN_010387e4(iVar24);
  if (iVar24 == 0) goto LAB_010398b4;
  func_0x0008009e((undefined1 *)((int)piVar26 + 0x29),0xff,0x10);
  if (1 < *piVar6) {
    FUN_0104ba04(PTR_s___s__s__s___sAbnormal_file__s_01039a1c,PTR_s_usbiap2_01039a04,
                 PTR_s__WRN__01039a10,PTR_s_usbiap2_get_files_information_01039a0c,puVar4,puVar4);
  }
LAB_0103999c:
  iVar24 = *piVar26 + (uStack_50 & 0xff);
  *(char *)piVar26 = (char)iVar24;
  *(char *)((int)piVar26 + 1) = (char)((uint)iVar24 >> 8);
  *(char *)((int)piVar26 + 3) = (char)((uint)iVar24 >> 0x18);
  *(char *)((int)piVar26 + 2) = (char)((uint)iVar24 >> 0x10);
  uStack_50 = uStack_50 & 0xffffff00;
  if (iStack_84 == 0) {
    uVar14 = 0x39;
    piStack_78 = piVar26;
  }
  else {
    uVar14 = 0x39U - iStack_84 & 0xff;
    piStack_78 = (int *)(iStack_84 + (int)piVar26);
    if (2 < *piVar6) {
      FUN_0104ba04(PTR_s___s__s__s___slast_read_offset_re_01039a20,PTR_s_usbiap2_01039a04,
                   PTR_s__INF__01039a00,PTR_s_usbiap2_get_files_information_01039a0c,puVar4,
                   iStack_84,puVar4);
    }
  }
  uVar29 = uStack_a8 + uVar14;
  iVar24 = iVar11 + uStack_a8;
  if (uVar23 == uVar29) {
    func_0x000800aa(iVar24,piStack_78,uVar14);
    if (2 < *piVar6) {
      FUN_0104ba04(PTR_s___s__s__s___sread_buf_limit__rea_01039bd0,PTR_s_usbiap2_01039bd8,
                   PTR_s__INF__01039bd4,PTR_s_usbiap2_get_files_information_01039bdc,puVar4,uVar23,
                   iStack_88,0,puVar4);
    }
    FUN_01066bd0(iStack_98);
    uStack_a8 = uVar29;
    uStack_a4 = uVar23;
    goto LAB_01039706;
  }
  if (uVar29 <= uVar23) {
    func_0x000800aa(iVar24,piStack_78,uVar14);
    iStack_84 = 0;
    uStack_a8 = uVar29;
    goto LAB_010398b4;
  }
  func_0x000800aa(iVar24,piStack_78,uVar23 - uStack_a8);
  if (2 < *piVar6) {
    FUN_0104ba04(PTR_s___s__s__s___sread_buf_limit__rea_01039bd0,PTR_s_usbiap2_01039bd8,
                 PTR_s__INF__01039bd4,PTR_s_usbiap2_get_files_information_01039bdc,puVar4,uVar23,
                 iStack_88,0,puVar4);
  }
  FUN_01066bd0(iStack_98);
  uStack_a8 = uVar23;
  uStack_a4 = uVar23;
LAB_01039706:
  uStack_54 = uStack_a8;
  if ((uStack_a8 == 0) && (0 < *piVar6)) {
    FUN_0104ba04(PTR_s___s__s__s___scannot_find__s__s_f_01039818,PTR_s_usbiap2_01039808,
                 PTR_s__ERR__01039804,PTR_s_usbiap2_get_files_information_01039800,puVar4,
                 PTR_DAT_0103981c,PTR_DAT_01039814,puVar4);
  }
  if (piVar26 != (int *)0x0) {
    FUN_0105a260(piVar26);
  }
  if (iStack_94 != 0) {
    FUN_0105a260(iStack_94);
  }
  if (iStack_98 != 0) {
    FUN_0105a260(iStack_98);
  }
  bVar1 = (int)uStack_a4 < 1;
LAB_01039756:
  uVar7 = (undefined1)(uStack_54 >> 8);
  *(char *)(param_1 + 8) = (char)uStack_54;
  *(undefined1 *)(param_1 + 9) = uVar7;
  *(undefined1 *)(param_1 + 10) = uVar7;
  *(char *)(param_1 + 0xb) = (char)uStack_54;
  func_0x000800aa(iStack_b8,param_1,0xc);
  uVar10 = FUN_0104f520();
  uVar14 = uStack_54;
  uVar29 = uStack_54 + 0xc;
  iVar11 = FUN_0104f730();
  if (((iVar11 != 1) && (uVar29 != 0x2000)) &&
     (iVar11 = func_0x00000558(uVar29,uVar10), iVar11 == 0)) {
    iVar11 = *(int *)(param_1 + 8) + 1;
    *(char *)(param_1 + 8) = (char)iVar11;
    *(char *)(param_1 + 9) = (char)((uint)iVar11 >> 8);
    *(char *)(param_1 + 10) = (char)((uint)iVar11 >> 0x10);
    *(char *)(param_1 + 0xb) = (char)((uint)iVar11 >> 0x18);
    func_0x000800aa(iStack_b8,param_1,0xc);
    uVar29 = uVar14 + 0xd;
    if (2 < *piVar6) {
      FUN_0104ba04(PTR_s___s__s__s___sfill_one_byte_len___01039828,PTR_s_usbiap2_01039808,
                   PTR_s__INF__01039824,PTR_s_usbiap2_hinotes_protocol_structu_01039820,puVar4,
                   uVar29,puVar4);
    }
  }
  do {
    while( true ) {
      if (uVar29 == 0) goto LAB_01039874;
      iVar11 = FUN_0104f730();
      if (iVar11 == 1) break;
      iStack_b8 = FUN_0104f67c(uVar29);
      iVar11 = *piVar6;
      puVar17 = PTR_s_usbiap2_hinotes_protocol_structu_0103a818;
      puVar19 = PTR_s__INF__0103a804;
      puVar18 = PTR_s_usbiap2_0103a800;
      puVar15 = PTR_s___s__s__s___sweb_write_buff_len___0103a820;
      if (iStack_b8 != 0) goto joined_r0x0103985a;
      if (2 < iVar11) {
        FUN_0104ba04(PTR_s___s__s__s___swait_usb_data_sendi_0103a824,PTR_s_usbiap2_0103a800,
                     PTR_s__INF__0103a804,PTR_s_usbiap2_hinotes_protocol_structu_0103a818,puVar4,
                     puVar4);
      }
      iVar11 = FUN_01090054();
      if (*(uint *)(iVar22 + 0x34) < (uint)(iVar11 - iStack_7c)) {
        iVar11 = *piVar6;
        puVar17 = PTR_s___s__s__s___sweb_write_timeout___0103a828;
joined_r0x0103a74c:
        if (0 < iVar11) {
          FUN_0104ba04(puVar17,PTR_s_usbiap2_0103a800,PTR_s__ERR__0103a7fc,
                       PTR_s_usbiap2_hinotes_protocol_structu_0103a818,puVar4,puVar4);
        }
        FUN_0104f740();
        bVar1 = true;
        goto LAB_01039874;
      }
LAB_0103a7c6:
      FUN_0108fad8(5);
    }
    iVar11 = FUN_0104f66c();
    if (iVar11 == 0) {
      if (2 < *piVar6) {
        FUN_0104ba04(PTR_s___s__s__s___swait_host_os_usb_da_0103a814,PTR_s_usbiap2_0103a800,
                     PTR_s__INF__0103a804,PTR_s_usbiap2_hinotes_protocol_structu_0103a818,puVar4,
                     puVar4);
      }
      iVar11 = FUN_01090054();
      if (*(uint *)(iVar22 + 0x34) < (uint)(iVar11 - iStack_7c)) {
        iVar11 = *piVar6;
        puVar17 = PTR_s___s__s__s___siap2_write_timeout___0103a81c;
        goto joined_r0x0103a74c;
      }
      goto LAB_0103a7c6;
    }
    iVar11 = FUN_01034c5c(*(undefined1 *)(*piVar5 + 8),iStack_b8,uVar29 & 0xffff);
  } while (iVar11 == 0);
  iVar11 = *piVar6;
  puVar17 = PTR_s_usbiap2_hinotes_protocol_structu_010399fc;
  puVar19 = PTR_s__INF__01039a00;
  puVar18 = PTR_s_usbiap2_01039a04;
  puVar15 = PTR_s___s__s__s___siap2_write_buff_len_01039a08;
joined_r0x0103985a:
  if (2 < iVar11) {
    FUN_0104ba04(puVar15,puVar18,puVar19,puVar17,puVar4,uVar29,puVar4);
  }
  iStack_7c = FUN_01090054();
LAB_01039874:
  *(undefined1 *)(param_1 + 4) = uVar2;
  *(undefined1 *)(param_1 + 5) = uVar20;
  *(undefined1 *)(param_1 + 6) = uVar20;
  *(undefined1 *)(param_1 + 7) = uVar2;
  uStack_a0 = uStack_a0 + uStack_54;
  if (bVar1) goto LAB_0103912a;
  goto LAB_0103907a;
}



/* FUN_0107ca40 @ 0107ca40 */

void FUN_0107ca40(int param_1)

{
  undefined2 uVar1;
  undefined *puVar2;
  int *piVar3;
  int iVar4;
  int iVar5;
  int iVar6;
  undefined4 uVar7;
  undefined2 *puVar8;
  int iVar9;
  int iVar10;
  undefined1 uStack_15;
  
  uStack_15 = 0;
  iVar4 = func_0x00080338();
  piVar3 = DAT_0107cbdc;
  iVar5 = FUN_0107c1ac();
  if (2 < *piVar3) {
    FUN_0108dd8c(PTR_s_<BT_I>_0107cbe4,0,0,PTR_s_Dev_connected__0107cbe8,1,PTR_DAT_0107cbe0,
                 *(undefined2 *)(param_1 + 8));
  }
  iVar6 = func_0x00080340();
  if (iVar6 == 2) {
    FUN_010a230c(*(undefined2 *)(param_1 + 8));
    iVar4 = *piVar3;
    puVar2 = PTR_s_bt_exiting_0107cbec;
  }
  else {
    if (((*(byte *)(*DAT_0107cbf0 + 0x2e) & 2) != 0) && (*(char *)(param_1 + 0xc) == '\x01')) {
      FUN_010773fc(param_1);
      return;
    }
    FUN_01087834();
    FUN_010874e8();
    iVar6 = FUN_01074bb8();
    if ((iVar6 != 0) || (*(byte *)(iVar4 + 1) < *(byte *)(iVar5 + 0x8e))) {
      func_0x000808e4();
      iVar10 = param_1 + 2;
      iVar6 = FUN_010788d0(iVar10);
      *(byte *)(iVar6 + 0x44) = *(byte *)(iVar6 + 0x44) & 199 | 1;
      iVar9 = *(int *)(iVar6 + 0x3c);
      uVar7 = FUN_01090054();
      puVar8 = *(undefined2 **)(iVar6 + 0x3c);
      *(undefined4 *)(iVar9 + 0xc) = uVar7;
      *(byte *)(puVar8 + 3) = *(byte *)(puVar8 + 3) & 0xf0 | 1;
      uVar1 = *(undefined2 *)(param_1 + 8);
      puVar8[0x1b] = 0;
      *puVar8 = uVar1;
      *(char *)(iVar4 + 1) = *(char *)(iVar4 + 1) + '\x01';
      if (*(short *)(iVar5 + 0x7c) == 1) {
        *DAT_0107cbf8 = uVar1;
      }
      iVar4 = FUN_01074bb8();
      if ((iVar4 == 3) || (iVar4 = FUN_01074bb8(), iVar4 == 4)) {
        *(byte *)(iVar6 + 0x44) = *(byte *)(iVar6 + 0x44) & 0xfe;
        FUN_0107d89c(param_1);
        FUN_0104ba04(PTR_s__s_010e7b80_0x33_0107cc00,PTR_s_PTS_device_address__0107cbfc);
        FUN_0108df4c(iVar10,1,6,0x10,0);
      }
      else {
        FUN_010774b4(param_1);
        FUN_0107c100(iVar10,2,iVar6 + 0x38);
      }
      iVar4 = FUN_0107c764(iVar10);
      if (iVar4 != 0) {
        *(byte *)(iVar6 + 0x44) = *(byte *)(iVar6 + 0x44) | 4;
        uStack_15 = 1;
        FUN_0107c100(iVar10,0x2e,&uStack_15);
      }
      FUN_0107c914(iVar10);
      FUN_01074d58(**(undefined2 **)(iVar6 + 0x3c));
      FUN_0107c9f0(iVar10);
      FUN_0108f974();
      return;
    }
    FUN_010a230c(*(undefined2 *)(param_1 + 8));
    iVar4 = *piVar3;
    puVar2 = PTR_s_dev_max_dis_0107cbf4;
  }
  if (2 < iVar4) {
    FUN_0108dd8c(PTR_s_<BT_I>_0107cbe4,0,0,puVar2,0,PTR_DAT_0107cbe0);
  }
  return;
}



/* FUN_0107d62c @ 0107d62c */

void FUN_0107d62c(int param_1)

{
  int iVar1;
  undefined4 uVar2;
  int iVar3;
  
  iVar1 = FUN_0107834c(*(undefined2 *)(param_1 + 2));
  if (iVar1 != 0) {
    if (*(char *)(param_1 + 4) == '\0') {
      if (2 < *DAT_0107d6bc) {
        FUN_0108dd8c(PTR_s_<BT_I>_0107d6c4,0,0,PTR_s_active_mode__0107d6c8,1,PTR_DAT_0107d6c0,
                     *(undefined2 *)(param_1 + 2));
      }
      iVar3 = *(int *)(iVar1 + 0x3c);
      *(byte *)(iVar3 + 6) = *(byte *)(iVar3 + 6) & 0xf;
      *(undefined1 *)(iVar3 + 7) = 0;
      uVar2 = FUN_01090054();
      *(undefined4 *)(iVar3 + 0xc) = uVar2;
      FUN_01088684(iVar1);
    }
    else if (*(char *)(param_1 + 4) == '\x02') {
      *(byte *)(*(int *)(iVar1 + 0x3c) + 6) = *(byte *)(*(int *)(iVar1 + 0x3c) + 6) & 0xf | 0x10;
      FUN_0104ba04(PTR_s_sniff_mode___02x___02x_0107d6cc,*(undefined2 *)(param_1 + 2),
                   *(undefined2 *)(param_1 + 6));
    }
  }
  return;
}



/* FUN_01076678 @ 01076678 */

void FUN_01076678(void)

{
  undefined4 uVar1;
  undefined1 auStack_c [8];
  
  func_0x000805dc(auStack_c);
  if ((*(byte *)(DAT_010766c8 + 2) & 2) != 0) {
    *(byte *)(DAT_010766c8 + 2) = *(byte *)(DAT_010766c8 + 2) & 0xfd;
    FUN_01076614(0);
    if (2 < *DAT_010766cc) {
      uVar1 = FUN_01090054();
      FUN_0104ba04(PTR_s___s__s__s___sLE_DeviceDiscovery__010766dc,PTR_s_general_010766d8,
                   PTR_s__INF__010766d4,PTR_s_APP_LE_DiscoveryCheck_010766e0,
                   PTR_s__010f8ede_0x1b_010766d0,uVar1,PTR_s__010f8ede_0x1b_010766d0);
    }
  }
  func_0x0008060c(auStack_c);
  return;
}



/* FUN_0108a9f0 @ 0108a9f0 */

undefined4 FUN_0108a9f0(int param_1,uint param_2)

{
  undefined4 uVar1;
  uint uVar2;
  int iVar3;
  
  if ((param_1 != 0) && (*(int *)(param_1 + 0x3c) != 0)) {
    uVar1 = FUN_01090054();
    uVar2 = FUN_0105e1fc(uVar1,*(undefined4 *)(*(int *)(param_1 + 0x3c) + 0xc));
    if (param_2 <= uVar2) {
      FUN_0106c4e8(3,0x150,0x1b,PTR_DAT_0108aa48,5,uVar2,uVar1,
                   *(undefined4 *)(*(undefined2 **)(param_1 + 0x3c) + 6),param_2,
                   **(undefined2 **)(param_1 + 0x3c));
      iVar3 = *(int *)(param_1 + 0x3c);
      uVar1 = FUN_01090054();
      *(undefined4 *)(iVar3 + 0xc) = uVar1;
      return 1;
    }
  }
  return 0;
}



/* FUN_0108aa4c @ 0108aa4c */

bool FUN_0108aa4c(int param_1)

{
  int iVar1;
  undefined4 uVar2;
  uint uVar3;
  short *psVar4;
  
  if (((param_1 != 0) && (*(int *)(param_1 + 0x3c) != 0)) &&
     (((*(byte *)(param_1 + 0x37) & 0xf0) != 0x20 || (iVar1 = FUN_01087754(), iVar1 != 1)))) {
    psVar4 = *(short **)(param_1 + 0x3c);
    if (((((*(byte *)(psVar4 + 3) & 0xf) != 0) && (*(byte *)((int)psVar4 + 7) < 4)) &&
        (*psVar4 != 0)) && ((*(byte *)(psVar4 + 3) & 0xf0) == 0)) {
      iVar1 = FUN_0107c0ec();
      if ((param_1 == iVar1) && (*(char *)(*(int *)(param_1 + 0x3c) + 3) == '\x02')) {
        uVar2 = FUN_01090054();
        uVar3 = FUN_0105e1fc(uVar2,*(undefined4 *)(*(int *)(param_1 + 0x3c) + 0xc));
        return 29999 < uVar3;
      }
      return true;
    }
  }
  return false;
}



/* FUN_0108ab9c @ 0108ab9c */

void FUN_0108ab9c(void)

{
  int iVar1;
  int iVar2;
  undefined4 uVar3;
  uint uVar4;
  
  iVar1 = func_0x00080338();
  iVar2 = FUN_0107c1ac();
  if ((((1 < *(byte *)(iVar2 + 0x8e)) && (*(byte *)(iVar1 + 1) < *(byte *)(iVar2 + 0x8e))) &&
      (iVar1 = FUN_0107c0ec(), iVar1 != 0)) &&
     ((*(int *)(iVar1 + 0x3c) != 0 &&
      ((iVar2 = FUN_0107855e(1), iVar2 != 0 || ((*(byte *)(*DAT_0108ac0c + 1) & 0x38) == 0x10))))))
  {
    func_0x000808e4();
    uVar3 = FUN_01090054();
    uVar4 = FUN_0105e1fc(uVar3,*(undefined4 *)(*(int *)(iVar1 + 0x3c) + 0x58));
    if (uVar4 < 3000) {
      uVar3 = 0x58;
    }
    else {
      uVar3 = 0;
    }
    FUN_0108ab38(iVar1,0,uVar3);
    FUN_0108f974();
  }
  return;
}



/* FUN_0108ac10 @ 0108ac10 */

void FUN_0108ac10(void)

{
  int iVar1;
  int iVar2;
  undefined4 uVar3;
  uint uVar4;
  uint uVar5;
  undefined1 uStack_15;
  
  iVar1 = func_0x00080338();
  if ((1 < *(byte *)(iVar1 + 1)) && (iVar1 = FUN_01087754(), iVar1 == 0)) {
    func_0x000808e4();
    iVar1 = FUN_0107c0ec();
    iVar2 = FUN_01078468(iVar1,&uStack_15);
    if ((iVar1 != 0) &&
       (((*(int *)(iVar1 + 0x3c) != 0 && (iVar2 != 0)) && (*(int *)(iVar2 + 0x3c) != 0)))) {
      uVar3 = FUN_01090054();
      uVar4 = FUN_0105e1fc(uVar3,*(undefined4 *)(*(int *)(iVar1 + 0x3c) + 0x58));
      uVar5 = FUN_0105e1fc(uVar3,*(undefined4 *)(*(int *)(iVar2 + 0x3c) + 0x58));
      if (uVar4 < 3000) {
        if (uVar5 < 3000) {
          uVar3 = 0x2c;
        }
        else {
          uVar3 = 0;
          if ((*(byte *)(*(undefined2 **)(iVar2 + 0x3c) + 3) & 0xf0) == 0) {
            uVar3 = 0x14;
          }
        }
      }
      else {
        uVar3 = 0;
      }
      FUN_0108ab38(iVar2,**(undefined2 **)(iVar2 + 0x3c),0);
      FUN_0108ab38(iVar1,**(undefined2 **)(iVar1 + 0x3c),uVar3);
    }
    FUN_0108f974();
  }
  return;
}



/* FUN_0108acc4 @ 0108acc4 */

void FUN_0108acc4(void)

{
  bool bVar1;
  int iVar2;
  int iVar3;
  undefined4 uVar4;
  uint uVar5;
  int iVar6;
  ushort uVar7;
  int iVar8;
  uint uVar9;
  ushort uStack_16;
  
  iVar2 = func_0x00080338();
  iVar3 = FUN_0107c1ac();
  uStack_16 = 5;
  if (1 < *(byte *)(iVar2 + 2)) {
    func_0x000808e4();
    bVar1 = false;
    for (uVar9 = 0; uVar9 < *(byte *)(iVar3 + 0x8e); uVar9 = uVar9 + 1 & 0xff) {
      iVar8 = *(int *)((uVar9 + 2) * 4 + iVar2);
      if ((iVar8 != 0) && (*(int *)(iVar8 + 0x3c) != 0)) {
        uVar4 = FUN_01090054();
        uVar5 = FUN_0105e1fc(uVar4,*(undefined4 *)(*(int *)(iVar8 + 0x3c) + 0x58));
        if (*(ushort *)(iVar3 + 0x9e) < uVar5) {
          *(byte *)(*(int *)(iVar8 + 0x3c) + 0xe9) = *(byte *)(*(int *)(iVar8 + 0x3c) + 0xe9) & 0xfe
          ;
        }
        if (((bVar1) || ((*(byte *)(iVar8 + 0x37) & 0xf0) != 0x10)) ||
           (iVar6 = *(int *)(iVar8 + 0x3c), (*(byte *)(iVar6 + 0xe9) & 3) != 3)) {
          *(undefined2 *)(*(int *)(iVar8 + 0x3c) + 0xea) = 0;
        }
        else {
          uVar7 = *(short *)(iVar6 + 0xea) + 1;
          *(ushort *)(iVar6 + 0xea) = uVar7;
          if (uStack_16 < uVar7) {
            iVar6 = *(int *)(iVar8 + 0x3c);
            *(undefined2 *)(iVar6 + 0xea) = 0;
            *(byte *)(iVar6 + 0xe9) = *(byte *)(iVar6 + 0xe9) & 0xfd;
            FUN_0107c100(iVar8,6,0);
            FUN_0107c100(iVar8,0x49,&uStack_16);
            bVar1 = true;
          }
        }
      }
    }
    FUN_0108f974();
  }
  return;
}



/* FUN_0108adba @ 0108adba */

void FUN_0108adba(void)

{
  int iVar1;
  int iVar2;
  int iVar3;
  undefined4 uVar4;
  uint uVar5;
  uint uVar6;
  int iVar7;
  
  iVar1 = func_0x00080338();
  iVar2 = FUN_0107c1ac();
  if (1 < *(byte *)(iVar1 + 2)) {
    for (uVar6 = 0; uVar6 < *(byte *)(iVar2 + 0x8e); uVar6 = uVar6 + 1 & 0xff) {
      iVar7 = *(int *)((uVar6 + 2) * 4 + iVar1);
      if ((((iVar7 != 0) && (*(int *)(iVar7 + 0x3c) != 0)) &&
          (iVar3 = FUN_0107c0ec(), iVar7 == iVar3)) && (*(short *)(iVar2 + 0x9c) != 0)) {
        uVar4 = FUN_01090054();
        uVar5 = FUN_0105e1fc(uVar4,*(undefined4 *)(*(int *)(iVar7 + 0x3c) + 0x58));
        if (*(ushort *)(iVar2 + 0x9c) < uVar5) {
          FUN_01074338(iVar7,1);
        }
      }
    }
  }
  return;
}



/* FUN_0108c3c4 @ 0108c3c4 */

uint FUN_0108c3c4(undefined4 param_1,byte *param_2)

{
  byte bVar1;
  short sVar2;
  int iVar3;
  int iVar4;
  int iVar5;
  undefined4 uVar6;
  uint uVar7;
  uint uVar8;
  int iVar9;
  uint uVar10;
  byte bVar11;
  byte bVar12;
  
  iVar3 = func_0x00080338();
  iVar4 = FUN_0107c1ac();
  uVar10 = (uint)param_2[1];
  uVar8 = (uint)*(ushort *)(param_2 + 2);
  iVar5 = FUN_0107834c((uVar10 & 0xf) << 8 | (uint)*param_2);
  if ((iVar5 == 0) || (iVar9 = *(int *)(iVar5 + 0x3c), iVar9 == 0)) {
    if ((uVar10 & 0xffffffc0) == 0xc0) {
      if (iVar3 == -0xbc) {
        uVar10 = 0;
      }
      else {
        uVar10 = *(uint *)(iVar3 + 0xc4);
      }
      if (*(int *)(iVar3 + 200) - 0x402U < uVar10) {
        FUN_0106c4e8(4,0x14d,0x578,PTR_DAT_0108c55c,1,uVar8 + 4);
        return 1;
      }
    }
  }
  else {
    uVar10 = uVar10 & 0x30;
    uVar6 = FUN_01090054();
    *(undefined4 *)(iVar9 + 0xc) = uVar6;
    if (uVar10 != 0x10) {
      sVar2 = *(short *)(param_2 + 6);
      iVar9 = *(int *)(iVar5 + 0x3c);
      *(undefined2 *)(iVar9 + 0xee) = *(undefined2 *)(param_2 + 4);
      if (*(short *)(iVar9 + 0x28) == sVar2) {
        *(undefined1 *)(iVar9 + 0xed) = 1;
        *(undefined1 *)(iVar9 + 0xec) = 0;
      }
      else {
        *(undefined1 *)(iVar9 + 0xed) = 0;
      }
    }
    iVar9 = *(int *)(iVar5 + 0x3c);
    if (iVar9 != 0) {
      if (*(char *)(iVar9 + 0xed) == '\x01') {
        uVar6 = FUN_01090054();
        *(undefined4 *)(iVar9 + 0x58) = uVar6;
        uVar7 = FUN_0108c2f0(iVar5,param_2,uVar10,uVar8);
        if (uVar7 != 0) {
          FUN_0106c4e8(4,0x14d,0x59c,PTR_DAT_0108c560,1,uVar8 + 4);
          return uVar7;
        }
        bVar1 = *(byte *)(iVar3 + 0x1a);
        if ((bVar1 != 0) &&
           (bVar11 = *(byte *)(iVar5 + 0x37) >> 4, bVar11 == *(byte *)(iVar3 + 0x1b))) {
          if (bVar11 == 2) {
            iVar4 = FUN_01087754();
            if (iVar4 != 2) goto LAB_0108c528;
            bVar12 = *(byte *)(iVar5 + 0x37) >> 4;
            uVar6 = 0x5ad;
            bVar11 = *(byte *)(iVar3 + 0x1b);
          }
          else {
            uVar6 = 0x5a6;
            bVar12 = bVar11;
          }
          FUN_0106c4e8(4,0x14d,uVar6,DAT_0108c564,2,bVar11,bVar12);
          return (uint)bVar1;
        }
LAB_0108c528:
        uVar8 = FUN_0108b78c(iVar5,param_2,uVar10,uVar8);
        return uVar8;
      }
      uVar6 = FUN_01090054();
      uVar8 = FUN_0105e1fc(uVar6,*(undefined4 *)(*(int *)(iVar5 + 0x3c) + 0x58));
      if (*(ushort *)(iVar4 + 0x9e) < uVar8) {
        *(byte *)(*(int *)(iVar5 + 0x3c) + 0xe9) = *(byte *)(*(int *)(iVar5 + 0x3c) + 0xe9) & 0xfe;
      }
    }
  }
  return 0;
}



/* FUN_0108bd20 @ 0108bd20 */

void FUN_0108bd20(undefined4 param_1,byte *param_2)

{
  int iVar1;
  undefined4 uVar2;
  int iVar3;
  uint uVar4;
  uint uVar5;
  uint uVar6;
  
  if ((*DAT_0108be00 == 0) || (iVar1 = (*(code *)(*DAT_0108be00 & 0xfffffffe))(param_1), iVar1 == 0)
     ) {
    uVar6 = (param_2[1] & 0xf) << 8 | (uint)*param_2;
    if (((uVar6 < 0xf00) && (uVar4 = (uint)*(ushort *)(param_2 + 2), (uVar4 - 1 & 0xffff) < 0x3fd))
       && ((uVar5 = param_2[1] & 0x30, uVar5 == 0x10 || ((uVar5 == 0x20 && (3 < uVar4)))))) {
      FUN_0108bcd0(param_2);
      iVar1 = FUN_0107834c(uVar6);
      if ((uVar5 == 0x10) || (iVar3 = FUN_0108bc5c(iVar1,param_2), iVar3 != 1)) {
        if (iVar1 != 0) {
          iVar3 = *(int *)(iVar1 + 0x3c);
          if (iVar3 != 0) {
            uVar2 = FUN_01090054();
            *(undefined4 *)(iVar3 + 0xc) = uVar2;
          }
          iVar3 = *(int *)(iVar1 + 0x3c);
          if ((iVar3 != 0) && (*(char *)(iVar3 + 0x54) == '\x01')) {
            uVar2 = FUN_01090054();
            *(undefined4 *)(iVar3 + 0x58) = uVar2;
            FUN_0108bbc8(iVar1,param_2,uVar5,uVar4);
            return;
          }
        }
        uVar4 = uVar4 + 4;
        uVar6 = 0x32;
        if (uVar4 < 0x33) {
          uVar6 = uVar4;
        }
        FUN_0108ca98(0,param_2,uVar6);
        iVar1 = func_0x00080338();
        uVar6 = **(uint **)(iVar1 + 0xb4);
        iVar1 = func_0x00080338();
        (*(code *)(uVar6 & 0xfffffffe))(*(undefined4 *)(iVar1 + 0xb8),param_2,uVar4,param_1);
      }
    }
  }
  return;
}



/* FUN_0107a608 @ 0107a608 */

void FUN_0107a608(int param_1)

{
  ushort *puVar1;
  uint uVar2;
  undefined4 uVar3;
  int iVar4;
  
  puVar1 = DAT_0107a650;
  uVar2 = FUN_010900b6(DAT_0107a650 + 6);
  uVar3 = FUN_01090054();
  *(undefined4 *)(puVar1 + 6) = uVar3;
  puVar1[8] = 0;
  puVar1[9] = 0;
  if (puVar1[1] < uVar2) {
    puVar1[1] = (ushort)uVar2;
  }
  *(int *)(puVar1 + 10) = *(int *)(puVar1 + 10) + param_1;
  iVar4 = FUN_01090054();
  if ((uint)*puVar1 <= (uint)(iVar4 - *(int *)(puVar1 + 2))) {
    uVar3 = FUN_01090054();
    *(undefined4 *)(puVar1 + 2) = uVar3;
    puVar1[4] = 0;
    puVar1[5] = 0;
    puVar1[1] = 0;
    puVar1[10] = 0;
    puVar1[0xb] = 0;
  }
  return;
}



/* FUN_01085f78 @ 01085f78 */

void FUN_01085f78(int param_1,uint *param_2)

{
  bool bVar1;
  char cVar2;
  char cVar3;
  ushort uVar4;
  int *piVar5;
  int iVar6;
  undefined4 uVar7;
  uint uVar8;
  int iVar9;
  uint uVar10;
  uint *puVar11;
  uint uVar12;
  uint uVar13;
  int iVar14;
  undefined *puVar15;
  int iVar16;
  int iVar17;
  undefined2 uVar18;
  uint uStack_54;
  uint *puStack_50;
  uint uStack_40;
  ushort uStack_2a;
  uint uStack_28;
  uint uStack_24;
  uint local_20;
  uint uStack_1c;
  uint uStack_18;
  
  iVar16 = *DAT_010860c8;
  uStack_1c = 0;
  uStack_18 = 0;
  uStack_28 = 0;
  uStack_24 = 0;
  local_20 = 0xffffffff;
  uStack_2a = 0;
  if (iVar16 == 0) {
    return;
  }
  if ((*(byte *)(iVar16 + 1) & 0xc0) != 0x80) {
    return;
  }
  if (*(byte *)(iVar16 + 0x1c1) < 2) {
    return;
  }
  if (((*(int *)(iVar16 + 0x80) != 0) && (*(uint *)(iVar16 + 0x148) != 0)) &&
     (iVar6 = (*(code *)(*(uint *)(iVar16 + 0x148) & 0xfffffffe))(), iVar6 != 0)) {
    if (0 < *DAT_010860cc) {
      FUN_0104ba04(PTR_s___s__s__s___s_d_s_010860dc,PTR_s_general_010860d8,PTR_s__ERR__010860d4,
                   PTR_s_bt_eg_tws_analyze_audio_data_syn_010860e0,PTR_s__010f8ede_0x1b_010860d0,
                   iVar6,PTR_s__010f8ede_0x1b_010860d0);
    }
    param_2 = (uint *)0x46;
    FUN_0107c100(0,0x46,0);
  }
  if (*(int *)(iVar16 + 0x18c) == 0) {
    return;
  }
  func_0x000808e4();
  uVar7 = FUN_0107b3a4();
  if (((((uint)param_2 & 0x80000000) != 0) || (*(int *)(iVar16 + 0x80) == 0)) ||
     (*(uint *)(iVar16 + 0x140) == 0)) goto LAB_010860be;
  if (*(char *)(iVar16 + 0x1c3) != '\0') {
    iVar6 = 0;
    puVar11 = param_2;
    do {
      if (((uStack_24 - local_20 == 4) || (iVar6 != 0)) || (*(char *)(iVar16 + 0x1c3) == '\0'))
      goto LAB_01086080;
      (*(code *)(*(uint *)(iVar16 + 0x140) & 0xfffffffe))
                (*(undefined4 *)(iVar16 + 0x80),&uStack_28,&uStack_24,&uStack_2a);
      do {
        puVar11 = &uStack_28;
        iVar6 = (*(code *)(*(uint *)(iVar16 + 0x140) & 0xfffffffe))
                          (*(undefined4 *)(iVar16 + 0x80),puVar11,&local_20,&uStack_2a);
        if (iVar6 != 0) break;
      } while (local_20 == uStack_24);
    } while( true );
  }
  puVar11 = &uStack_28;
  (*(code *)(*(uint *)(iVar16 + 0x140) & 0xfffffffe))
            (*(int *)(iVar16 + 0x80),puVar11,&uStack_24,&uStack_2a);
LAB_01086080:
  iVar6 = func_0x00080408();
  uVar8 = (*(code *)(*(uint *)(iVar16 + 0x144) & 0xfffffffe))(*(undefined4 *)(iVar16 + 0x80));
  func_0x00080082();
  cVar2 = *(char *)(iVar16 + 0x15f);
  if (cVar2 == '\0') {
    FUN_0106c4e8(3,0x174,0x12a,PTR_DAT_010860e4,0);
    goto LAB_010860be;
  }
  uVar13 = (uint)*(ushort *)(iVar16 + 0x162) * 0x10000;
  uVar12 = (uint)CARRY4((uint)uStack_2a,uVar13);
  iVar9 = uStack_2a + uVar13 + 1;
  if (iVar9 == 0) {
    uVar12 = uVar12 + 1;
  }
  uVar13 = func_0x00000588(iVar9,uVar12,uStack_28,0);
  uStack_40 = (uVar13 - uStack_24) - uVar8;
  iVar9 = ((uVar12 - (uStack_24 <= uVar13 ^ 1)) - (int)puVar11) - (uVar8 <= uVar13 - uStack_24 ^ 1);
  cVar3 = *(char *)(iVar16 + 0x1be);
  if (cVar3 == '\0') {
LAB_01086142:
    uStack_54 = FUN_010005ac(uVar7,param_2,cVar2,0);
    puStack_50 = (uint *)((int)param_2 << 7 | uStack_54 >> 0x19);
    uStack_54 = uStack_54 << 7;
  }
  else if (cVar3 == '\x02') {
    FUN_010005ac(uVar7,param_2,cVar2,0);
    uStack_54 = func_0x00000588();
    puStack_50 = param_2;
  }
  else {
    if (cVar3 == '\x01') goto LAB_01086142;
    uStack_54 = 0;
    puStack_50 = (uint *)0x0;
  }
  uVar12 = uStack_40 >> 2 | iVar9 * 0x40000000;
  uStack_1c = uStack_54 - uVar12;
  uStack_18 = (int)puStack_50 + (-(uVar12 <= uStack_54 ^ 1) - (iVar9 >> 2));
  if (((int)uStack_18 < 1) && ((uStack_18 != 0 || (uStack_1c < 0x10001)))) {
    if ((uStack_18 & 0x80000000) != 0) {
      FUN_0106c4e8(3,0x174,0x163,PTR_DAT_01086544,3,uStack_1c,uVar7,uStack_54);
      goto LAB_010860be;
    }
  }
  else {
    FUN_0106c4e8(3,0x174,0x149,PTR_DAT_01086328,0);
    FUN_0106c4e8(3,0x174,0x14a,PTR_DAT_0108632c,1,*(undefined2 *)(iVar16 + 0x162));
    FUN_0106c4e8(3,0x174,0x14b,PTR_DAT_01086330,1,uVar7);
    FUN_0106c4e8(3,0x174,0x14c,PTR_DAT_01086334,1,uStack_40);
    FUN_0106c4e8(3,0x174,0x14d,PTR_DAT_01086330,1,uVar7);
    FUN_0108df4c(&uStack_1c,1,8,0x10,0xffffffff);
    bVar1 = CARRY4(uStack_40,uStack_28 * 0x10000);
    uStack_40 = uStack_40 + uStack_28 * 0x10000;
    iVar9 = iVar9 + (uint)bVar1;
    uVar12 = uStack_40 >> 2 | iVar9 * 0x40000000;
    uStack_1c = uStack_54 - uVar12;
    uStack_18 = (int)puStack_50 + (-(uVar12 <= uStack_54 ^ 1) - (iVar9 >> 2));
    if ((uStack_18 != 0) || (0x10000 < uStack_1c)) {
      FUN_0106c4e8(1,0x174,0x156,PTR_DAT_01086338,0,uVar7);
      FUN_0108df4c(&uStack_1c,1,8,0x10,0xffffffff);
      goto LAB_010860be;
    }
    *(short *)(iVar16 + 0x162) = *(short *)(iVar16 + 0x162) + 1;
  }
  uVar13 = uStack_18;
  uVar12 = uStack_1c;
  *(uint *)(iVar16 + 0x194) = uStack_1c;
  if (param_1 == 0x10) {
    iVar9 = 0;
  }
  else {
    iVar17 = iVar6 - *(int *)(iVar16 + 0x18c);
    if ((DAT_0108633c < iVar17 - 1U) || (uVar4 = *(ushort *)(iVar16 + 0xe6), uVar4 == 0)) {
      FUN_0106c4e8(2,0x174,0x178,PTR_DAT_01086548,1,iVar17);
      goto LAB_010860be;
    }
    uVar10 = *(uint *)(iVar16 + 400);
    func_0x00000588(uVar10 - uStack_1c,
                    (((int)uVar10 >> 0x1f) - uStack_18) - (uStack_1c <= uVar10 ^ 1),10000,0);
    iVar9 = FUN_010005ac();
    iVar9 = iVar9 - iVar17;
    uVar10 = func_0x0000049c((uint)uVar4 * iVar17,10000);
    uStack_1c = uVar12 + uVar10;
    uStack_18 = uVar13 + CARRY4(uVar12,uVar10);
  }
  *(undefined4 *)(iVar16 + 0x150) = *(undefined4 *)(iVar16 + 0x14c);
  uVar12 = (uint)(short)((short)*(undefined4 *)(iVar16 + 400) - (short)uStack_1c);
  *(uint *)(iVar16 + 0x14c) = uVar12;
  if ((uStack_24 == uStack_28) || (uStack_28 == local_20)) {
    *(int *)(iVar16 + 0x158) = iVar9;
  }
  else {
    uVar7 = *(undefined4 *)(iVar16 + 0x154);
    *(int *)(iVar16 + 0x154) = iVar9;
    *(undefined4 *)(iVar16 + 0x158) = uVar7;
  }
  if (*(char *)(iVar16 + 0x1c1) == '\x02') {
    FUN_0104ba04(PTR_s_trigger_time_diff__d_local__d_re_01086528,iVar6 - *(int *)(iVar16 + 0x18c),
                 iVar6,*(int *)(iVar16 + 0x18c),*(undefined4 *)(iVar16 + 400),uStack_1c,uStack_54,
                 uStack_40,*(undefined1 *)(iVar16 + 0x15f));
    if (param_1 == 0x10) {
      uVar18 = *(undefined2 *)(iVar16 + 0xe6);
      iVar17 = func_0x0000049c(uVar12 * 10000,uVar18);
      iVar17 = iVar17 + *(int *)(iVar16 + 0x18c);
      iVar14 = iVar17 - iVar6;
      *(int *)(iVar16 + 0x188) = iVar17;
      uVar7 = 0x199;
      puVar15 = PTR_DAT_0108652c;
    }
    else if ((int)uVar12 < 1) {
      uVar13 = uVar12;
      if ((uVar12 & 0x80000000) != 0) {
        uVar13 = -uVar12;
      }
      if (500 < (int)uVar13) {
        FUN_0106c4e8(3,0x174,0x1a8,DAT_01086550,1,uVar12);
        FUN_0107c100(0,0x46,0);
        goto LAB_010863f0;
      }
      uVar18 = *(undefined2 *)(iVar16 + 0xe6);
      iVar14 = func_0x0000049c(uVar12 * 10000,uVar18);
      iVar17 = iVar6 + iVar14;
      *(int *)(iVar16 + 0x188) = iVar17;
      uVar7 = 0x1ad;
      puVar15 = PTR_FUN_01086584;
    }
    else {
      uVar18 = *(undefined2 *)(iVar16 + 0xe6);
      iVar14 = func_0x0000049c(uVar12 * 10000,uVar18);
      iVar17 = iVar6 + iVar14;
      *(int *)(iVar16 + 0x188) = iVar17;
      uVar7 = 0x1a1;
      puVar15 = PTR_FUN_0108654c;
    }
    FUN_0106c4e8(3,0x174,uVar7,puVar15,5,uVar12,iVar6,iVar17,uVar18,iVar14);
    if (*(int *)(iVar16 + 0x7c) != 0) {
      FUN_01088138();
    }
  }
LAB_010863f0:
  piVar5 = DAT_01086530;
  iVar17 = FUN_01090054();
  if (2000 < (uint)(iVar17 - *piVar5)) {
    FUN_0106c4e8(3,0x174,0x1b9,DAT_01086534,1,*(undefined2 *)(iVar16 + 0xe6));
    FUN_0106c4e8(3,0x174,0x1ba,DAT_01086538,3,iVar9,uVar12,*(undefined1 *)(iVar16 + 0xe8));
    FUN_0106c4e8(3,0x174,0x1bb,DAT_0108653c,1,iVar6);
    FUN_0106c4e8(3,0x174,0x1bc,DAT_01086540,1,uVar8);
    iVar16 = FUN_01090054();
    *piVar5 = iVar16;
  }
LAB_010860be:
  FUN_0108f974();
  return;
}



/* FUN_01086fb8 @ 01086fb8 */

void FUN_01086fb8(void)

{
  byte bVar1;
  char *pcVar2;
  undefined1 uVar3;
  int iVar4;
  int iVar5;
  uint uVar6;
  undefined4 uVar7;
  int iVar8;
  uint uVar9;
  int iVar10;
  byte *pbVar11;
  int iVar12;
  
  iVar4 = FUN_0107dfe0();
  iVar10 = *DAT_01087170;
  iVar8 = *(int *)(iVar10 + 0x48);
  iVar5 = FUN_0107c1ac();
  if ((((((iVar8 != 0) && ((*(byte *)(iVar10 + 1) & 0xc0) == 0x40)) &&
        (*(short *)(iVar10 + 0x54) != 0)) &&
       ((*(int *)(iVar10 + 0xdc) != 0 && (*(char *)(iVar10 + 0x1c0) == '\0')))) &&
      ((iVar4 == 0 ||
       ((*(int *)(iVar4 + 0x3c) == 0 || ((*(uint *)(*(int *)(iVar4 + 0x3c) + 0x60) & 0xffffff) == 0)
        ))))) && (iVar4 = func_0x00080420(), iVar4 != 0)) {
    pbVar11 = (byte *)(iVar10 + 0xec);
    bVar1 = *pbVar11;
    iVar4 = FUN_010741a8();
    if (iVar4 <= (int)(uint)bVar1) {
      FUN_0108f0e4(iVar10 + 0xc4,0xffffffff);
      pcVar2 = DAT_01087174;
      uVar6 = FUN_010a282c(*(undefined2 *)(iVar10 + 0x54));
      uVar6 = uVar6 >> 0x10;
      if ((*(byte *)(iVar10 + 2) & 3) < uVar6) {
        *pcVar2 = '\0';
        while ((uVar6 != (*(byte *)(iVar10 + 2) & 3) && (*pbVar11 != 0))) {
          iVar4 = 0;
          do {
            uVar9 = (uint)*(ushort *)(pbVar11 + (*(byte *)(iVar10 + 0xee) + 2) * 2);
            *pbVar11 = *pbVar11 - 1;
            uVar3 = func_0x00000558(*(byte *)(iVar10 + 0xee) + 1 & 0xff,0x28);
            *(undefined1 *)(iVar10 + 0xee) = uVar3;
            if (*(char *)(iVar5 + 0x32) != '\0') {
              uVar7 = FUN_0107a6e4();
              FUN_010729f8(uVar7,0,uVar9);
            }
            FUN_010729f8(*(undefined4 *)(iVar10 + 0xdc),iVar4 + 0x16 + iVar8,uVar9);
            iVar4 = iVar4 + uVar9;
          } while ((*pbVar11 != 0) &&
                  ((uint)*(ushort *)(pbVar11 + (*(byte *)(iVar10 + 0xee) + 2) * 2) + iVar4 < 0x28b))
          ;
          FUN_01086f5c(iVar8,iVar4 + 0x16,0);
          FUN_010a2854(*(undefined2 *)(iVar10 + 0x54),1,0);
          iVar4 = FUN_0107c0ec();
          if ((iVar4 != 0) &&
             ((iVar12 = *(int *)(iVar4 + 0x3c), iVar12 != 0 &&
              ((*(byte *)(iVar4 + 0x37) & 0xf0) == 0x20)))) {
            uVar7 = FUN_01090054();
            *(undefined4 *)(iVar12 + 0x58) = uVar7;
          }
          uVar9 = FUN_010a282c(*(undefined2 *)(iVar10 + 0x54));
          FUN_0106c4e8(4,0x175,0xbf,DAT_01087180,3,uVar9 >> 0x10,uVar9 & 0xffff,uVar6);
          *(char *)(iVar10 + 0x46) = *(char *)(iVar10 + 0x46) + '\x01';
          uVar6 = uVar6 - 1;
        }
      }
      else if (*pcVar2 == '\0') {
        uVar7 = *(undefined4 *)(iVar10 + 0xdc);
        *DAT_01087178 = *DAT_01087178 + '\x01';
        uVar7 = func_0x00080420(uVar7);
        FUN_0106c4e8(3,0x175,0x97,DAT_0108717c,2,uVar7,uVar6);
        *pcVar2 = '\x01';
      }
      FUN_0108f1b0(iVar10 + 0xc4);
    }
  }
  return;
}



/* FUN_01089900 @ 01089900 */

void FUN_01089900(void)

{
  uint uVar1;
  undefined4 uVar2;
  uint uVar3;
  int iVar4;
  int iVar5;
  int iVar6;
  byte bVar7;
  int iVar8;
  undefined1 auStack_3c [10];
  undefined1 auStack_32 [3];
  char cStack_2f;
  
  iVar6 = *DAT_01089a34;
  if ((*(short *)(iVar6 + 0x54) != 0) && (iVar4 = *(int *)(iVar6 + 0x94), iVar4 != 0)) {
    if ((*(byte *)(iVar6 + 1) & 0xc0) == 0x40) {
      iVar4 = *(int *)(iVar4 + 8);
    }
    else {
      iVar4 = *(int *)(iVar4 + 0x1c);
    }
    if (iVar4 != 0) {
      FUN_0108f0e4(iVar6 + 0xc4,0xffffffff);
      uVar1 = FUN_010a282c(*(undefined2 *)(iVar6 + 0x54));
      uVar1 = uVar1 >> 0x10;
      if ((*(byte *)(iVar6 + 2) & 3) < uVar1) {
        for (; uVar1 != (*(byte *)(iVar6 + 2) & 3); uVar1 = uVar1 - 1) {
          iVar4 = *(int *)(iVar6 + 0x94);
          if ((*(byte *)(iVar6 + 1) & 0xc0) == 0x40) {
            if (iVar4 == 0) break;
            iVar5 = *(int *)(iVar4 + 8);
            iVar8 = iVar4;
          }
          else {
            iVar8 = iVar4 + 0x14;
            if (iVar8 == 0) break;
            iVar5 = *(int *)(iVar4 + 0x1c);
          }
          if (iVar5 < 1) break;
          func_0x0008004a(iVar8,auStack_32,0x1c);
          bVar7 = cStack_2f + 4;
          FUN_01086ef0(auStack_3c,1,bVar7 + 1,0);
          FUN_0108a0a0(auStack_3c,bVar7 + 10);
          FUN_010a2854(*(undefined2 *)(iVar6 + 0x54),1,0);
          iVar4 = FUN_0107c0ec();
          if (((iVar4 != 0) && (iVar8 = *(int *)(iVar4 + 0x3c), iVar8 != 0)) &&
             ((*(byte *)(iVar4 + 0x37) & 0xf0) == 0x20)) {
            uVar2 = FUN_01090054();
            *(undefined4 *)(iVar8 + 0x58) = uVar2;
          }
          uVar3 = FUN_010a282c(*(undefined2 *)(iVar6 + 0x54));
          FUN_0106c4e8(4,0x176,0x5e,DAT_01089a3c,3,uVar3 >> 0x10,uVar3 & 0xffff,uVar1);
          *(char *)(iVar6 + 0x46) = *(char *)(iVar6 + 0x46) + '\x01';
        }
      }
      else {
        FUN_0106c4e8(4,0x176,0x2d,DAT_01089a38,2,0,uVar1);
      }
      FUN_0108f1b0(iVar6 + 0xc4);
    }
  }
  return;
}



/* FUN_01086b18 @ 01086b18 */

void FUN_01086b18(void)

{
  byte bVar1;
  char *pcVar2;
  byte bVar3;
  undefined1 uVar4;
  undefined2 uVar5;
  int iVar6;
  uint uVar7;
  undefined4 uVar8;
  uint uVar9;
  int iVar10;
  int iVar11;
  uint uStack_20;
  
  iVar6 = FUN_0107dfe0();
  iVar11 = *DAT_01086bd4;
  iVar10 = *(int *)(iVar11 + 0x48);
  if ((((((iVar10 != 0) && ((*(byte *)(iVar11 + 1) & 0xc0) == 0x40)) &&
        (*(short *)(iVar11 + 0x54) != 0)) && (*(int *)(iVar11 + 0xdc) != 0)) &&
      (((iVar6 == 0 || (*(int *)(iVar6 + 0x3c) == 0)) ||
       ((*(uint *)(*(int *)(iVar6 + 0x3c) + 0x60) & 0xffffff) == 0)))) &&
     (1 < *(byte *)(iVar11 + 0x1c1))) {
    FUN_0108f0e4(iVar11 + 0xc4,0xffffffff);
    if (*(char *)(iVar11 + 0x1c1) == '\x02') {
      FUN_01086ab8();
    }
    pcVar2 = DAT_01086bd8;
    uVar7 = FUN_010a282c(*(undefined2 *)(iVar11 + 0x54));
    uVar7 = uVar7 >> 0x10;
    if ((*(byte *)(iVar11 + 2) & 3) < uVar7) {
      *pcVar2 = '\0';
      if (*(char *)(iVar11 + 0x15f) != '\0') {
        uVar8 = func_0x00080420(*(undefined4 *)(iVar11 + 0xdc));
        bVar1 = *(byte *)(iVar11 + 0x15f);
        uVar5 = func_0x0000049c(uVar8,bVar1);
        *(undefined2 *)(iVar11 + 0x15c) = uVar5;
        bVar3 = func_0x0000049c(0x294,bVar1);
        *(byte *)(iVar11 + 0x15e) = bVar3;
        *(ushort *)(iVar11 + 0x160) = (ushort)bVar1 * (ushort)bVar3;
      }
      if (((*(char *)(iVar11 + 0x1c2) != '\0') && (iVar6 = FUN_0105d610(), iVar6 == 0)) ||
         (1 < *(ushort *)(iVar11 + 0x15c))) {
        while ((uVar7 != (*(byte *)(iVar11 + 2) & 3) && (*(short *)(iVar11 + 0x15c) != 0))) {
          iVar6 = FUN_0108f58c(iVar11 + 0x198,0);
          if (iVar6 == 0) {
            FUN_0106c4e8(3,0x174,0x38b,DAT_01086df4,1,0x38b);
          }
          else {
            *(byte *)(iVar11 + 0x1ac) = *(byte *)(iVar11 + 0x1ac) & 0xf | *(char *)(iVar6 + 5) << 4;
            uVar4 = *(undefined1 *)(iVar6 + 0xc);
            *(undefined1 *)(iVar11 + 0x1b1) = *(undefined1 *)(iVar6 + 8);
            *(undefined1 *)(iVar11 + 0x1b2) = *(undefined1 *)(iVar6 + 9);
            *(undefined1 *)(iVar11 + 0x1b3) = *(undefined1 *)(iVar6 + 10);
            *(undefined1 *)(iVar11 + 0x1b4) = *(undefined1 *)(iVar6 + 0xb);
            *(undefined1 *)(iVar11 + 0x1af) = uVar4;
            *(undefined1 *)(iVar11 + 0x1b0) = *(undefined1 *)(iVar6 + 0xd);
            *(byte *)(iVar11 + 0x1ac) =
                 *(byte *)(iVar11 + 0x1ac) & 0xf3 | (*(byte *)(iVar11 + 0x1c3) & 3) << 2;
            *(undefined1 *)(iVar6 + 4) = 0;
            *(undefined1 *)(iVar11 + 0x1ae) = 0;
            if (*(char *)(iVar11 + 0x1c1) == '\x03') {
              *(undefined1 *)(iVar11 + 0x1b1) = *(undefined1 *)(iVar11 + 0x188);
              *(undefined1 *)(iVar11 + 0x1b2) = *(undefined1 *)(iVar11 + 0x189);
              *(undefined1 *)(iVar11 + 0x1b3) = *(undefined1 *)(iVar11 + 0x18a);
              *(undefined1 *)(iVar11 + 0x1b4) = *(undefined1 *)(iVar11 + 0x18b);
              *(undefined1 *)(iVar11 + 0x1ae) = 0x10;
            }
          }
          *(byte *)(iVar11 + 0x1ac) =
               *(byte *)(iVar11 + 0x1ac) & 0xfc | *(byte *)(iVar11 + 0x1be) & 3;
          uVar4 = FUN_0105d5f8();
          *(undefined1 *)(iVar11 + 0x1b5) = uVar4;
          FUN_010729f8(*(undefined4 *)(iVar11 + 0xdc),iVar10 + 0x16,*(undefined1 *)(iVar11 + 0x15f))
          ;
          *(short *)(iVar11 + 0x15c) = *(short *)(iVar11 + 0x15c) + -1;
          uStack_20 = (uint)*(byte *)(iVar11 + 0x15f);
          while ((uStack_20 + *(byte *)(iVar11 + 0x15f) < 0x294 && (*(short *)(iVar11 + 0x15c) != 0)
                 )) {
            FUN_010729f8(*(undefined4 *)(iVar11 + 0xdc),uStack_20 + 0x16 + iVar10);
            *(short *)(iVar11 + 0x15c) = *(short *)(iVar11 + 0x15c) + -1;
            uStack_20 = uStack_20 + *(byte *)(iVar11 + 0x15f);
            iVar6 = FUN_0108f58c(iVar11 + 0x198,0);
            if (iVar6 == 0) {
              FUN_0106c4e8(3,0x174,0x3a1,DAT_01086df4,1,0x3a1);
            }
            else {
              *(undefined1 *)(iVar6 + 4) = 0;
            }
          }
          uVar8 = FUN_01090054();
          *(undefined4 *)(iVar11 + 0x1c4) = uVar8;
          FUN_01086f5c(iVar10,uStack_20 + 0x16,0);
          FUN_010a2854(*(undefined2 *)(iVar11 + 0x54),1,0);
          FUN_0107c0ec();
          uVar9 = FUN_010a282c(*(undefined2 *)(iVar11 + 0x54));
          FUN_0106c4e8(4,0x174,0x3b3,DAT_01086df0,3,uVar9 >> 0x10,uVar9 & 0xffff,uVar7);
          *(char *)(iVar11 + 0x46) = *(char *)(iVar11 + 0x46) + '\x01';
          uVar7 = uVar7 - 1;
        }
      }
    }
    else if (*pcVar2 == '\0') {
      uVar8 = *(undefined4 *)(iVar11 + 0xdc);
      *DAT_01086bdc = *DAT_01086bdc + '\x01';
      uVar8 = func_0x00080420(uVar8);
      FUN_0106c4e8(3,0x174,0x35a,DAT_01086be0,2,uVar8,uVar7);
      *pcVar2 = '\x01';
    }
    FUN_0108f1b0(iVar11 + 0xc4);
  }
  return;
}



/* FUN_01087db8 @ 01087db8 */

void FUN_01087db8(int param_1,int param_2)

{
  int *piVar1;
  int iVar2;
  
  if ((((*(byte *)(*DAT_01087e14 + 1) & 0xc0) == 0x40) && (*(short *)(*DAT_01087e14 + 0x54) != 0))
     && (iVar2 = FUN_01072cc8(*(undefined4 *)(*(int *)(param_1 + 0x24) + 0x18)),
        piVar1 = DAT_01087e18, iVar2 < param_2)) {
    FUN_01086e80(param_2);
    iVar2 = FUN_01090054();
    if (100 < (uint)(iVar2 - *piVar1)) {
      FUN_0106c4e8(3,0x17c,0x49,DAT_01087e1c,0);
      *piVar1 = iVar2;
    }
  }
  return;
}



/* FUN_01090054 @ 01090054 */

undefined4 FUN_01090054(void)

{
  return *DAT_0109005c;
}



/* FUN_01020e20 @ 01020e20 */

int FUN_01020e20(uint param_1)

{
  byte bVar1;
  char *pcVar2;
  uint uVar3;
  int iVar4;
  
  pcVar2 = DAT_01020ee0;
  if (param_1 < 9) {
    if (param_1 == 7) {
      uVar3 = 3;
    }
    else {
      uVar3 = param_1;
      if (param_1 == 8) {
        bVar1 = *(byte *)(*DAT_01020ee4 + 2);
        *DAT_01020ee0 = '\0';
        uVar3 = (uint)bVar1;
      }
    }
  }
  else {
    uVar3 = 1;
  }
  if (*pcVar2 == '\0') {
    iVar4 = FUN_0101fac8(uVar3);
    if (iVar4 == 0) {
      if (2 < *DAT_01020ee8) {
        FUN_0104ba04(PTR_s___s__s__s___sswitch_to__d_bt1_he_01020f00,PTR_s_general_01020ef4,
                     PTR_s__INF__01020ef0,PTR_s_dsp_dev_write_AudioPath_01020efc,
                     PTR_s__010f8ede_0x1b_01020eec,uVar3,PTR_s__010f8ede_0x1b_01020eec);
      }
      if (param_1 == 7) {
        *pcVar2 = '\x01';
      }
      else {
        *(char *)(*DAT_01020ee4 + 2) = (char)uVar3;
      }
    }
    else if (0 < *DAT_01020ee8) {
      FUN_0104ba04(PTR_s___s__s__s___s_s__d__Write_AudioP_01020f08,PTR_s_general_01020ef4,
                   PTR_s__ERR__01020f04,PTR_s_dsp_dev_write_AudioPath_01020efc,
                   PTR_s__010f8ede_0x1b_01020eec,PTR_s_dsp_dev_write_AudioPath_01020efc,0x151,iVar4,
                   PTR_s__010f8ede_0x1b_01020eec);
    }
  }
  else if (param_1 == 7) {
    iVar4 = 1;
  }
  else {
    if (2 < *DAT_01020ee8) {
      FUN_0104ba04(PTR_s___s__s__s___sswitch_lock__d_bt1_h_01020ef8,PTR_s_general_01020ef4,
                   PTR_s__INF__01020ef0,PTR_s_dsp_dev_write_AudioPath_01020efc,
                   PTR_s__010f8ede_0x1b_01020eec,uVar3,PTR_s__010f8ede_0x1b_01020eec);
    }
    iVar4 = 0;
    *(char *)(*DAT_01020ee4 + 2) = (char)uVar3;
  }
  return iVar4;
}



/* FUN_01021024 @ 01021024 */

int FUN_01021024(void)

{
  int *piVar1;
  int *piVar2;
  int iVar3;
  undefined *puVar4;
  int iVar5;
  undefined4 uVar6;
  
  piVar2 = DAT_01021138;
  piVar1 = DAT_01021134;
  if (*DAT_01021134 != 0) {
    if (*DAT_01021138 < 3) {
      return 0;
    }
    FUN_0104ba04(PTR_s___s__s__s___sdsp_already_init__s_01021148,PTR_s_general_01021144,
                 PTR_s__INF__01021140,PTR_s_dsp_dev_init_0102114c,PTR_s__010f8ede_0x1b_0102113c,
                 PTR_s__010f8ede_0x1b_0102113c);
    return 0;
  }
  iVar3 = FUN_0105a24c(0x40);
  *piVar1 = iVar3;
  puVar4 = PTR_s_GPIO_0_01021158;
  if (iVar3 == 0) {
    if (0 < *piVar2) {
      uVar6 = 0x1cb;
      puVar4 = PTR_s___s__s__s___s_s__d__malloc_fail__01021150;
LAB_01021098:
      FUN_0104ba04(puVar4,PTR_s_general_01021144,PTR_s__ERR__01021154,PTR_s_dsp_dev_init_0102114c,
                   PTR_s__010f8ede_0x1b_0102113c,PTR_s_dsp_dev_init_0102114c,uVar6,
                   PTR_s__010f8ede_0x1b_0102113c);
    }
  }
  else {
    func_0x0008009e(iVar3,0,0x40);
    iVar5 = *piVar1;
    *(undefined1 *)(iVar5 + 2) = 1;
    iVar3 = FUN_0108e250(puVar4);
    *(int *)(iVar5 + 8) = iVar3;
    if (iVar3 == 0) {
      if (0 < *piVar2) {
        FUN_0104ba04(PTR_s___s__s__s___s_s__d__err_binding___0102115c,PTR_s_general_01021144,
                     PTR_s__ERR__01021154,PTR_s_dsp_dev_init_0102114c,PTR_s__010f8ede_0x1b_0102113c,
                     PTR_s_dsp_dev_init_0102114c,0x1d6,puVar4,PTR_s__010f8ede_0x1b_0102113c);
      }
    }
    else {
      iVar3 = (*(code *)(**(uint **)(*(int *)(*piVar1 + 8) + 4) & 0xfffffffe))
                        (*(int *)(*piVar1 + 8),0,0x2a,1);
      if (iVar3 == 0) {
        iVar3 = 0;
        if (2 < *piVar2) {
          FUN_0104ba04(PTR_s___s__s__s___s_s__d__dsp_init__s_01021164,PTR_s_general_01021144,
                       PTR_s__INF__01021140,PTR_s_dsp_dev_init_0102114c,
                       PTR_s__010f8ede_0x1b_0102113c,PTR_s_dsp_dev_init_0102114c,0x1e7,
                       PTR_s__010f8ede_0x1b_0102113c);
        }
        goto LAB_0102106a;
      }
      if (0 < *piVar2) {
        uVar6 = 0x1dc;
        puVar4 = PTR_s___s__s__s___s_s__d__err_configur_01021160;
        goto LAB_01021098;
      }
    }
  }
  iVar3 = -1;
LAB_0102106a:
  if (*piVar1 == 0) {
    return iVar3;
  }
  if (iVar3 == 0) {
    return 0;
  }
  FUN_0105a260();
  *piVar1 = 0;
  return -1;
}



/* FUN_010211f0 @ 010211f0 */

undefined4 FUN_010211f0(void)

{
  int *piVar1;
  uint *puVar2;
  int iVar3;
  byte *pbVar4;
  uint uVar5;
  undefined4 uVar6;
  
  piVar1 = DAT_01021370;
  if ((byte *)*DAT_01021370 == (byte *)0x0) {
    uVar6 = 0xffffffff;
  }
  else {
    uVar5 = (uint)*(byte *)*DAT_01021370;
    if (uVar5 != 0) {
      if (uVar5 < 5) {
        iVar3 = *DAT_01021374;
        *DAT_01021374 = iVar3 + 1;
        puVar2 = DAT_01021378;
        iVar3 = func_0x000005cc(iVar3 + 1,100);
        if ((iVar3 == 1) || (uVar5 != *puVar2)) {
          if (2 < *DAT_0102137c) {
            FUN_0104ba04(PTR_s___s__s__s___sdsp_work_STATE___d___0102138c,PTR_s_general_01021388,
                         PTR_s__INF__01021384,PTR_s_dsp_dev_dowork_01021390,
                         PTR_s__010f8ede_0x1b_01021380,uVar5,PTR_s__010f8ede_0x1b_01021380);
          }
          *puVar2 = (uint)*(byte *)*piVar1;
        }
      }
      pbVar4 = (byte *)*piVar1;
      if (*pbVar4 - 1 < 5) {
        func_0x00000b4c();
        FUN_01020b1a(*(undefined4 *)(pbVar4 + 8),0x2a,0);
        FUN_0108fad8(5);
        FUN_01020b1a(*(undefined4 *)(*piVar1 + 8),0x2a,1);
        FUN_0108fad8(0x1e);
        FUN_01020b1a(*(undefined4 *)(*piVar1 + 8),0x2a,0);
        if (2 < *DAT_0102137c) {
          FUN_0104ba04(PTR_s___s__s__s___s_s__d__dsp_reset____01021398,PTR_s_general_01021388,
                       PTR_s__INF__01021384,PTR_s_dsp_dev_reset_01021394,
                       PTR_s__010f8ede_0x1b_01021380,PTR_s_dsp_dev_reset_01021394,0x55,
                       PTR_s__010f8ede_0x1b_01021380);
        }
        *(undefined1 *)*piVar1 = 3;
      }
    }
    uVar6 = 0;
  }
  return uVar6;
}



/* FUN_010214a4 @ 010214a4 */

undefined4 FUN_010214a4(uint param_1)

{
  int *piVar1;
  undefined *puVar2;
  undefined *puVar3;
  undefined4 uVar4;
  
  piVar1 = DAT_010215e4;
  if (*DAT_010215e0 == 0) {
    if (*DAT_010215e4 < 1) {
      return 0xffffffff;
    }
    uVar4 = 0x299;
    puVar2 = PTR_s___s__s__s___s_s__d__dsp_no_init___010215f0;
    puVar3 = PTR_s__ERR__010215f8;
  }
  else {
    if (2 < *DAT_010215e4) {
      FUN_0104ba04(PTR_s___s__s__s___sdsp_setoption___d___01021600,PTR_s_general_010215f4,
                   PTR_s__INF__010215fc,PTR_s_dsp_dev_setoption_010215ec,
                   PTR_s__010f8ede_0x1b_010215e8,param_1,PTR_s__010f8ede_0x1b_010215e8);
    }
    if (param_1 < 0x10) {
      uVar4 = func_0x00000b38(param_1);
      return uVar4;
    }
    if (*piVar1 < 2) {
      return 0xffffffff;
    }
    uVar4 = 0x30b;
    puVar2 = PTR_s___s__s__s___s_s__d__undefined__s_0102161c;
    puVar3 = PTR_s__WRN__01021620;
  }
  FUN_0104ba04(puVar2,PTR_s_general_010215f4,puVar3,PTR_s_dsp_dev_setoption_010215ec,
               PTR_s__010f8ede_0x1b_010215e8,PTR_s_dsp_dev_setoption_010215ec,uVar4,
               PTR_s__010f8ede_0x1b_010215e8);
  return 0xffffffff;
}



/* FUN_01021624 @ 01021624 */

undefined4 FUN_01021624(int param_1)

{
  undefined *puVar1;
  undefined *puVar2;
  undefined4 uVar3;
  
  if (*DAT_01021700 == 0) {
    if (*DAT_01021704 < 1) {
      return 0xffffffff;
    }
    uVar3 = 0x31a;
    puVar1 = PTR_s___s__s__s___s_s__d__invalid_para_01021710;
    puVar2 = PTR_s__ERR__01021718;
  }
  else {
    if (param_1 - 1U < 0xf) {
      uVar3 = func_0x00000b38();
      return uVar3;
    }
    if (*DAT_01021704 < 2) {
      return 0xffffffff;
    }
    uVar3 = 0x352;
    puVar1 = PTR_s___s__s__s___s_s__d__undefined__s_01021720;
    puVar2 = PTR_s__WRN__01021724;
  }
  FUN_0104ba04(puVar1,PTR_s_general_01021714,puVar2,PTR_s_dsp_dev_getoption_0102170c,
               PTR_s__010f8ede_0x1b_01021708,PTR_s_dsp_dev_getoption_0102170c,uVar3,
               PTR_s__010f8ede_0x1b_01021708);
  return 0xffffffff;
}



/* FUN_01020430 @ 01020430 */

int FUN_01020430(int param_1,uint param_2)

{
  uint *puVar1;
  undefined *puVar2;
  uint *puVar3;
  int iVar4;
  undefined *puVar5;
  int iVar6;
  int iVar7;
  undefined4 uVar8;
  int iVar9;
  uint uVar10;
  uint uVar11;
  uint uVar12;
  uint uVar13;
  undefined4 *puVar14;
  uint uVar15;
  char cVar16;
  undefined4 *puVar17;
  uint uVar18;
  uint uVar19;
  uint uVar20;
  uint uStack_74;
  char cStack_54;
  char cStack_53;
  char cStack_52;
  char cStack_51;
  uint uStack_50;
  uint uStack_4c;
  uint uStack_48;
  int iStack_44;
  int iStack_40;
  int iStack_3c;
  int iStack_38;
  undefined4 uStack_34;
  undefined4 uStack_30;
  int iStack_2c;
  int iStack_28;
  undefined1 uStack_24;
  undefined1 uStack_23;
  undefined1 uStack_22;
  byte bStack_21;
  uint uStack_1c;
  int iStack_18;
  
  func_0x0008009e(&iStack_2c,0,0x18);
  puVar1 = DAT_01020600;
  uStack_50 = 0;
  uStack_4c = 0;
  uStack_48 = 0;
  if (param_1 == 0) {
    return 2;
  }
  iVar4 = (*(code *)(*DAT_01020600 & 0xfffffffe))(DAT_01020604,&uStack_48);
  if (iVar4 != 0) {
    FUN_010201d8(2,PTR_s_Unable_to_read_system_status_reg_01020608);
    return iVar4;
  }
  uVar11 = uStack_48 & 3;
  uVar12 = param_2 & 0x21;
  uVar15 = param_2;
  uStack_48 = uVar11;
  if (uVar12 == 0x21) {
    puVar5 = PTR_s_Not_in_Bootloader_mode___08X_0102060c;
    if (uVar11 != 1) goto LAB_01020488;
  }
  else {
    puVar5 = PTR_s_Not_in_Application_mode___08X_01020614;
    if (uVar11 != 2) {
LAB_01020488:
      FUN_0103c5fc(puVar5,uVar11);
      return 1;
    }
    cVar16 = '\0';
    for (; param_2 != 0; param_2 = param_2 >> 1) {
      if ((param_2 & 1) != 0) {
        iVar4 = FUN_010200ec(cVar16,&cStack_54,&cStack_53,&cStack_52,&cStack_51);
        if (iVar4 != 0) {
          FUN_010201d8(2,PTR_s_Unable_to_read_the_processor_and_01020618);
          return iVar4;
        }
        if (((cStack_54 == '\0') || (cStack_52 == '\0')) || (cStack_51 != '\0')) {
          if (cStack_52 == '\0') {
            iVar4 = FUN_0101fdcc(cVar16,2);
            puVar5 = PTR_s_Unable_to_stall_processor__d_0102062c;
            if (((iVar4 != 0) ||
                (iVar4 = FUN_0101fdcc(cVar16,1),
                puVar5 = PTR_s_Unable_to_power_on_processor__d_01020628, iVar4 != 0)) ||
               (iVar4 = FUN_0101ff4c(cVar16,1),
               puVar5 = PTR_s_Unable_to_power_on_processor__d_d_01020630, iVar4 != 0))
            goto LAB_01020558;
            goto LAB_010205a8;
          }
          if (cStack_51 != '\0') {
            FUN_0103c5fc(PTR_s_Processor__d_memory_is_in_retent_01020620,cVar16);
            iVar4 = FUN_0101ff4c(cVar16,3);
            puVar5 = PTR_s_Unable_to_bring_processor__d_ded_01020624;
            if (iVar4 != 0) goto LAB_01020558;
          }
          iVar4 = FUN_0101fdcc(cVar16,1);
          puVar5 = PTR_s_Unable_to_power_on_processor__d_01020628;
          if (iVar4 != 0) {
LAB_01020558:
            FUN_0103c5fc(puVar5,cVar16);
            return iVar4;
          }
        }
        else {
          FUN_0103c5fc(PTR_s_Processor__d_is_already_running__0102061c,cVar16);
          if (cStack_53 == '\0') {
            return 6;
          }
        }
        iVar4 = 0;
        goto LAB_0102050a;
      }
LAB_010205a8:
      cVar16 = cVar16 + '\x01';
    }
    uVar11 = FUN_0101f358(5);
    puVar5 = PTR_s_Update_block_failed_with_error_c_010e5e08_0xd_01020610;
    if (uVar11 != 0) goto LAB_01020488;
  }
  iVar4 = FUN_010202c4(param_1,PTR_DAT_01020634);
  if (iVar4 == 0) {
    FUN_0103c5fc(PTR_s_Failed_to_open_the_input_binary_f_01020638,param_1);
    return 2;
  }
  iVar6 = FUN_0102033c(&iStack_2c,0x18,1,iVar4);
  puVar5 = PTR_s_Binary_file_header_read_failed_0102063c;
  if (iVar6 == 1) {
    FUN_0103c5fc(PTR_s_File_Name___s_01020640,param_1);
    FUN_0103c5fc(PTR_s_________________Header___________01020644);
    iVar6 = iStack_28;
    iVar7 = iStack_2c;
    FUN_0103c5fc(PTR_s_Signature1__0x_08X__Signature2__0_01020648,iStack_2c,iStack_28);
    uVar11 = (uint)bStack_21;
    FUN_0103c5fc(PTR_s_enc_salt__0x_02X__prod_id__0x_02_01020810,uStack_24,uStack_23,uStack_22,
                 uVar11,uVar15,iVar6,iVar7);
    FUN_0103c5fc(PTR_s_Number_of_Sections___d_01020814,uStack_1c);
    FUN_0103c5fc(PTR_s_Program_Entry__0x_08X_01020818,iStack_18);
    FUN_0103c5fc(PTR_s_____________End_Header___________0102081c);
    puVar5 = PTR_s_Invalid_signature__Bad_binary_fi_01020828;
    if (((iStack_2c == DAT_01020820) && (iStack_28 == DAT_01020824)) &&
       (puVar5 = PTR_s_No_sections_to_be_downloaded_0102082c, 1 < uStack_1c)) {
      FUN_0101f8f0(&uStack_34);
      FUN_0101f8fa(&uStack_34,uStack_1c);
      iVar6 = iStack_18;
      FUN_0101f8fa(&uStack_34,iStack_18);
      iVar7 = DAT_01020830;
      for (uVar20 = 0; uVar20 < uStack_1c - 1; uVar20 = uVar20 + 1) {
        uVar8 = FUN_0102038c(iVar4);
        iVar9 = FUN_0102033c(&uStack_50,4,1,iVar4,uVar11,uVar15,iVar6);
        puVar5 = PTR_s_Sect_len_and_sect_addr_could_not_0102083c;
        if ((iVar9 != 1) ||
           (iVar9 = FUN_0102033c(&uStack_4c,4,1,iVar4,uVar11,uVar15,iVar6),
           puVar5 = PTR_s_Sect_len_and_sect_addr_could_not_0102083c, iVar9 != 1)) goto LAB_010205dc;
        if (uStack_50 != 0) {
          uVar13 = *(uint *)(iVar7 + 0x18);
          uVar18 = uStack_50;
          if (uVar13 <= uStack_50) {
            uVar18 = uVar13;
          }
          if ((((uStack_4c < 0x10001) && ((uVar15 & 1) != 0)) ||
              ((uStack_4c + 0xc0000000 <= DAT_01020840 && (uVar12 != 0)))) ||
             ((uStack_4c + 0xe0000000 < 0x800001 && ((uVar15 & 0x20) != 0)))) {
            uVar13 = 1;
          }
          else if (uStack_4c + 0x5a000000 < 0x800001) {
            uVar13 = uVar15 >> 4 & 1;
          }
          else {
            uVar13 = 0;
          }
          if (0x3fffffff < uVar18) {
            iVar6 = 7;
            FUN_010201d8(2,PTR_s_File_size_exceeds_limit____01020844);
            goto LAB_0102079a;
          }
          puVar17 = (undefined4 *)FUN_01020250(uVar18 << 2);
          uVar18 = uStack_50;
          puVar5 = PTR_s_Out_of_memory____01020848;
          if (puVar17 == (undefined4 *)0x0) goto LAB_010207b4;
          uStack_74 = uStack_4c;
          FUN_0101f8fa(&uStack_34,uStack_50);
          FUN_0101f8fa(&uStack_34,uStack_4c);
          FUN_0101f8f0(&iStack_44);
          FUN_0101f8f0(&iStack_3c);
          puVar2 = PTR_s_read_sectLenTemp___d_sectAddrTem_0102084c;
          while (puVar3 = DAT_01020854, uVar18 != 0) {
            uVar19 = *(uint *)(iVar7 + 0x18);
            if (uVar18 < uVar19) {
              uVar19 = uVar18;
            }
            uVar10 = FUN_0102033c(puVar17,4,uVar19,iVar4);
            puVar5 = PTR_s_Reading_section_data_from_file_f_01020a04;
            if (uVar19 != uVar10) goto LAB_010207b4;
            puVar14 = puVar17;
            for (uVar10 = 0; uVar10 != uVar19; uVar10 = uVar10 + 1) {
              FUN_0101f8fa(&iStack_3c,*puVar14);
              FUN_0101f8fa(&uStack_34,*puVar14);
              puVar14 = puVar14 + 1;
            }
            if ((uVar13 != 0) && (iVar6 = FUN_0101eed8(uStack_74,puVar17,uVar10), iVar6 != 0)) {
              FUN_010201d8(2,PTR_s_Binary_data_send_failed_01020a00);
              goto LAB_010208ac;
            }
            uVar18 = uVar18 - uVar10;
            uStack_74 = uStack_74 + uVar10 * 4;
            FUN_0103c5fc(puVar2,uVar18);
          }
          iVar6 = 0;
          if (uVar13 == 0) {
LAB_010209be:
            FUN_01020258(puVar17);
            goto LAB_010209c4;
          }
          uVar11 = uStack_4c;
          FUN_0103c5fc(PTR_s_Section__d__fileOffset___08X__se_01020850,uVar20,uVar8,uStack_50);
          iVar6 = (*(code *)(*puVar3 & 0xfffffffe))(DAT_01020858,iStack_44);
          puVar5 = PTR_s_Write_to_ChkSum_Val1_reg_failed_010209fc;
          if ((((iVar6 == 0) &&
               (iVar6 = (*(code *)(*puVar3 & 0xfffffffe))(DAT_01020a08,iStack_40),
               puVar5 = PTR_s_Write_to_ChkSum_Val2_reg_failed_01020a0c, iVar6 == 0)) &&
              (iVar6 = (*(code *)(*puVar3 & 0xfffffffe))(DAT_01020a10,uStack_4c),
              puVar5 = PTR_s_Writing_to_checksum_buffer_addre_01020a14, iVar6 == 0)) &&
             ((iVar6 = (*(code *)(*puVar3 & 0xfffffffe))(DAT_01020a18,uStack_50),
              puVar5 = PTR_s_Writing_to_checksum_buffer_lengt_01020a1c, iVar6 == 0 &&
              (iVar6 = (*(code *)(*DAT_01020a20 & 0xfffffffe))(DAT_01020a24,1,1),
              puVar5 = PTR_s_Writing_to_checksum_register_fai_01020a28, iVar6 == 0)))) {
            iVar6 = FUN_0101f358(5);
            if (iVar6 == 0) {
              iVar6 = (*(code *)(*puVar1 & 0xfffffffe))(DAT_01020a30,&iStack_44);
              puVar5 = PTR_s_Check_sum_Val_1_register_read_fa_01020a34;
              if ((iVar6 == 0) &&
                 (iVar6 = (*(code *)(*puVar1 & 0xfffffffe))(DAT_01020a08,&iStack_40),
                 puVar5 = PTR_s_Check_sum_Val_2_register_read_fa_01020a38, iVar6 == 0)) {
                FUN_0103c5fc(PTR_s_Section_checksum_on_Device__0x_0_01020a3c,iStack_40,iStack_44);
                iVar6 = iStack_3c;
                FUN_0103c5fc(PTR_s_Section_checksum_on_Host___0x_04_01020a40,iStack_38,iStack_3c);
                puVar5 = PTR_s_Checksum_mismatch_for_this_secti_01020a44;
                if ((iStack_3c == iStack_44) && (iStack_38 == iStack_40)) goto LAB_010209be;
              }
              goto LAB_010207b4;
            }
            FUN_0103c5fc(PTR_s_BinDownload__Update_block_failed_01020a2c,iVar6);
          }
          else {
LAB_010207b4:
            FUN_010201d8(2,puVar5);
          }
          iVar6 = 1;
          goto LAB_010208ac;
        }
LAB_010209c4:
      }
      FUN_010201d8(4,PTR_s_Download_complete_01020834);
      iVar7 = FUN_0102033c(&uStack_50,4,1,iVar4,uVar11,uVar15,iVar6);
      puVar17 = DAT_01020a48;
      puVar5 = PTR_s_File_operation_failed_01020838;
      if ((iVar7 == 1) &&
         (iVar6 = FUN_0102033c(DAT_01020a48,4,1,iVar4,uVar11,uVar15,iVar6),
         puVar5 = PTR_s_File_operation_failed_01020838, iVar6 == 1)) {
        FUN_0103c5fc(PTR_s_Expected_Binary_Checksum__0x_X_01020a4c,*puVar17);
        FUN_0103c5fc(PTR_s_Actual_Binary_Checksum__0x_04X_0_01020a50,uStack_30,uStack_34);
        iVar6 = FUN_0101f91c(&uStack_34,*puVar17);
        if (iVar6 == 0) {
          iVar6 = 0;
          FUN_010201d8(2,PTR_s_Checksum_verification_FAILED__Bi_01020b08);
          goto LAB_0102079a;
        }
        FUN_010201d8(4,PTR_s_Checksum_OK_01020af0);
        if (uStack_48 == 1) {
          if (uVar12 == 0x21) {
            (*(code *)(*DAT_01020af4 & 0xfffffffe))(DAT_01020af8,iStack_18);
            (*(code *)(*DAT_01020afc & 0xfffffffe))(DAT_01020b00,1,1);
            FUN_0101f180(5);
            goto LAB_01020a94;
          }
LAB_0102050a:
          cVar16 = '\0';
          for (; uVar15 != 0; uVar15 = uVar15 >> 1) {
            if (((uVar15 & 1) != 0) && (iVar6 = FUN_0101fdcc(cVar16,3), iVar6 != 0)) {
              FUN_0103c5fc(PTR_s_Unable_to_bring_processor__d_out_01020b0c,cVar16);
              goto LAB_01020ad4;
            }
            cVar16 = cVar16 + '\x01';
          }
          iVar7 = FUN_0101f358(5);
          if (iVar7 == 0) goto LAB_01020a94;
          iVar6 = 1;
          FUN_0103c5fc(PTR_s_Update_block_failed_with_error_c_010e5e08_0xd_01020610,iVar7);
        }
        else {
          if (uVar12 != 0x21) goto LAB_0102050a;
LAB_01020a94:
          iVar6 = 0;
          FUN_010201d8(4,PTR_s_Device_running_the_downloaded_bi_01020b04);
        }
LAB_01020ad4:
        if (iVar4 == 0) {
          return iVar6;
        }
        goto LAB_0102079a;
      }
    }
  }
LAB_010205dc:
  iVar6 = 1;
  FUN_010201d8(2,puVar5);
LAB_0102079a:
  puVar17 = (undefined4 *)0x0;
LAB_010208ac:
  FUN_0102031c(iVar4);
  if (puVar17 != (undefined4 *)0x0) {
    FUN_01020258(puVar17);
    return iVar6;
  }
  return iVar6;
}



/* FUN_0102041c @ 0102041c */

void FUN_0102041c(undefined4 param_1,undefined4 param_2)

{
  FUN_01020398(DAT_0102042c,param_1,param_2);
  return;
}



